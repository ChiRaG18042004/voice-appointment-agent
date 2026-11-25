"""The tools the LLM can call during a call.

Each tool is a plain async function. Pipecat reads the name, type hints and
docstring to build the function-calling schema it sends to Gemini, so the
docstrings below are effectively part of the prompt.
"""

from __future__ import annotations

from datetime import datetime

from loguru import logger
from pipecat.frames.frames import EndWorkerFrame
from pipecat.services.llm_service import FunctionCallParams

import store
from events import bus


def _err(msg: str) -> dict:
    return {"ok": False, "error": msg}


async def check_doctor_availability(
    params: FunctionCallParams,
    doctor_name: str | None = None,
    speciality: str | None = None,
    date: str | None = None,
):
    """Look up open appointment slots. Call this before offering any time to the caller.

    Args:
        doctor_name: Doctor the caller asked for, e.g. "Dr. Rao" or "Ananya". Leave empty if not given.
        speciality: Kind of doctor if no name was given, e.g. "skin", "cardiologist", "child specialist".
        date: Only return slots on this day, in YYYY-MM-DD format. Leave empty for the next open slots.
    """
    logger.info(f"check_doctor_availability doctor={doctor_name} speciality={speciality} date={date}")
    bus.publish("tool", {"name": "check_doctor_availability", "args": dict(params.arguments)})
    try:
        result = store.find_availability(doctor_name, speciality, date)
        # Show the dashboard which diary rows and open slots the agent is reading.
        rows = result.get("results", [])
        offered = [s["slot_id"] for r in rows for s in r["open_slots"][:3]]
        if rows:
            bus.publish(
                "scan",
                {
                    "doctor_ids": [r["doctor_id"] for r in rows],
                    "doctors": [r["doctor"] for r in rows],
                    "slots": store.slot_starts(offered),
                    "date": date,
                },
            )
        await params.result_callback({"ok": True, **result})
    except store.StoreError as e:
        await params.result_callback(_err(str(e)))


async def book_appointment(
    params: FunctionCallParams,
    slot_id: str,
    phone_number: str,
    patient_name: str,
    phone_confirmed: bool,
):
    """Book one open slot for the caller.

    Only call this after you have read the phone number back digit by digit and the
    caller said it is correct.

    Args:
        slot_id: The slot_id exactly as returned by check_doctor_availability.
        phone_number: The caller's 10-digit mobile number, digits only.
        patient_name: Name of the patient the appointment is for.
        phone_confirmed: True only if the caller confirmed the number you read back.
    """
    logger.info(f"book_appointment slot={slot_id} phone={phone_number} confirmed={phone_confirmed}")
    bus.publish("tool", {"name": "book_appointment", "args": {"slot_id": slot_id}})
    if not phone_confirmed:
        await params.result_callback(
            _err("Read the phone number back to the caller digit by digit and get a yes before booking.")
        )
        return
    try:
        appt = store.book(slot_id, phone_number, patient_name)
    except store.StoreError as e:
        await params.result_callback(_err(str(e)))
        return
    bus.publish("appointment_booked", appt)
    await params.result_callback({"ok": True, "booked": True, **appt})


async def cancel_appointment(
    params: FunctionCallParams,
    phone_number: str,
    phone_confirmed: bool,
    appointment_id: str | None = None,
):
    """Cancel the caller's upcoming appointment, found by their phone number.

    Only call this after reading the number back and getting a yes. If the number has
    several bookings, the result lists them; ask which one, then call again with its
    appointment_id.

    Args:
        phone_number: The caller's 10-digit mobile number, digits only.
        phone_confirmed: True only if the caller confirmed the number you read back.
        appointment_id: Which booking to cancel, only needed when the number has more than one.
    """
    logger.info(f"cancel_appointment phone={phone_number} id={appointment_id} confirmed={phone_confirmed}")
    bus.publish("tool", {"name": "cancel_appointment", "args": {}})
    if not phone_confirmed:
        await params.result_callback(
            _err("Read the phone number back to the caller digit by digit and get a yes before cancelling.")
        )
        return
    try:
        result = store.cancel(phone_number, appointment_id)
    except store.StoreError as e:
        await params.result_callback(_err(str(e)))
        return
    if result.get("cancelled"):
        bus.publish("appointment_cancelled", result)
    await params.result_callback({"ok": True, **result})


async def end_call(params: FunctionCallParams):
    """Hang up. Call this only after you have said goodbye and the caller has nothing else."""
    await params.result_callback({"ok": True})
    # Downstream EndWorkerFrame lets the goodbye finish playing before the pipeline stops.
    await params.llm.push_frame(EndWorkerFrame())


ALL_TOOLS = [check_doctor_availability, book_appointment, cancel_appointment, end_call]


def system_prompt() -> str:
    today = datetime.now()
    doctors = "\n".join(f"- {d['name']}, {d['speciality']}" for d in store.list_doctors())
    return f"""You are Mira, the phone receptionist at Larkspur Clinic. You book and cancel doctor appointments by voice.

Today is {today:%A %d %B %Y} (ISO {today:%Y-%m-%d}). The clinic is open Monday to Saturday.

Doctors:
{doctors}

How you work:
- The caller is identified only by the mobile number they say. Ask for it when you need to book or cancel.
- Before booking or cancelling, read the number back digit by digit, grouped five and five, like "9 8 7 6 5, 4 3 2 1 0", and ask if it is right. Only then call the tool with phone_confirmed true. If they correct it, read the new one back again.
- Always call check_doctor_availability before offering times. Never invent a slot. Offer two or three options, not the whole list.
- Turn relative dates like "tomorrow" or "Friday" into YYYY-MM-DD yourself.
- For a booking you also need the patient's name.
- After booking, confirm the doctor, day and time in one sentence. Never say slot ids aloud.
- If a tool returns an error, explain it simply and offer a way forward.
- When the caller is done, say a short goodbye and then call end_call.

Style: warm, brisk, one or two short sentences per turn, like a real front desk. Your words are spoken aloud, so no lists, emojis, markdown or abbreviations like "e.g."."""
