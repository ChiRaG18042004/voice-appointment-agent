"""One voice session: browser audio -> STT -> LLM (+tools) -> TTS -> browser audio."""

from __future__ import annotations

import os

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi.observer import (
    RTVIFunctionCallReportLevel,
    RTVIObserverParams,
)
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

import store
from tools import ALL_TOOLS, system_prompt

DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"  # ElevenLabs premade "Sarah"; override in .env


def make_llm():
    """Gemini by default; set LLM_PROVIDER=groq in .env to use Groq instead."""
    settings = {"system_instruction": system_prompt(), "temperature": 0.4}

    if os.getenv("LLM_PROVIDER", "google").lower() == "groq":
        from pipecat.services.groq.llm import GroqLLMService

        model = os.getenv("GROQ_MODEL") or "llama-3.3-70b-versatile"
        logger.info(f"LLM: Groq {model}")
        return GroqLLMService(
            api_key=os.environ["GROQ_API_KEY"],
            settings=GroqLLMService.Settings(model=model, **settings),
        )

    from pipecat.services.google.llm import GoogleLLMService

    if os.getenv("GOOGLE_MODEL"):
        settings["model"] = os.environ["GOOGLE_MODEL"]
    return GoogleLLMService(
        api_key=os.environ["GOOGLE_API_KEY"],
        settings=GoogleLLMService.Settings(**settings),
    )


async def run_bot(webrtc_connection: SmallWebRTCConnection) -> None:
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    # Doctor names as key terms so Scribe spells "Iyer" and "Kapoor" right.
    keyterms = [d["name"].replace("Dr. ", "") for d in store.list_doctors()]
    stt = ElevenLabsRealtimeSTTService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsRealtimeSTTService.Settings(language=Language.EN, keyterms=keyterms),
    )

    llm = make_llm()

    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(
            voice=os.getenv("ELEVENLABS_VOICE_ID") or DEFAULT_VOICE,
            model=os.getenv("ELEVENLABS_TTS_MODEL") or "eleven_flash_v2_5",
        ),
    )

    # Tools listed on the context are registered with the LLM automatically.
    context = LLMContext(tools=ALL_TOOLS)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        # Silero VAD decides when the caller starts/stops talking (and enables barge-in).
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline(
        [
            transport.input(),  # caller mic over WebRTC
            stt,  # ElevenLabs Scribe realtime
            user_aggregator,  # adds the caller's turn to the context
            llm,  # Gemini, may call tools
            tts,  # ElevenLabs voice
            transport.output(),  # audio back to the browser
            assistant_aggregator,  # records what the bot actually said
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        # Tell the browser which tool is running (name only, no arguments).
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={"*": RTVIFunctionCallReportLevel.NAME}
        ),
    )
    runner = WorkerRunner(handle_sigint=False)

    @worker.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        logger.info("Client ready, greeting caller")
        context.add_message(
            {"role": "user", "content": "(The caller has just connected.) Greet them as Larkspur Clinic and ask how you can help. One sentence."}
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Caller hung up")
        await runner.cancel()

    await runner.add_workers(worker)
    await runner.run()