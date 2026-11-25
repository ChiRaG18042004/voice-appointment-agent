"""Exercise the three tools end to end without any API keys.

    python test_tools.py
"""

import asyncio
from types import SimpleNamespace

import store
import tools

store.DB_PATH = store.DB_PATH.with_name("test_clinic.db")


class Call(SimpleNamespace):
    """Stand-in for pipecat's FunctionCallParams: captures the result."""

    async def result_callback(self, result, **_):
        self.result = result


async def run(fn, **kwargs):
    call = Call(arguments=kwargs, result=None)
    await fn(call, **kwargs)
    return call.result


async def main():
    store.init_db(reset=True)

    # 1. availability by speciality
    r = await run(tools.check_doctor_availability, speciality="skin")
    assert r["ok"] and r["results"][0]["doctor"] == "Dr. Sara Khan", r
    slot = r["results"][0]["open_slots"][0]["slot_id"]

    # misheard name still resolves
    r = await run(tools.check_doctor_availability, doctor_name="Anaya Row")
    assert r["ok"] and r["results"][0]["doctor"] == "Dr. Ananya Rao", r

    # 2. booking refuses without a confirmed number
    r = await run(tools.book_appointment, slot_id=slot, phone_number="98765 43210",
                  patient_name="test user", phone_confirmed=False)
    assert not r["ok"]

    r = await run(tools.book_appointment, slot_id=slot, phone_number="+91 98765 43210",
                  patient_name="test user", phone_confirmed=True)
    assert r["ok"] and r["phone"] == "9876543210", r
    print("booked:", r["appointment_id"], r["doctor"], r["when"])

    # same slot can't be booked twice
    r = await run(tools.book_appointment, slot_id=slot, phone_number="9876543210",
                  patient_name="someone else", phone_confirmed=True)
    assert not r["ok"] and "taken" in r["error"]

    # bad number
    r = await run(tools.book_appointment, slot_id=slot, phone_number="98765",
                  patient_name="x", phone_confirmed=True)
    assert not r["ok"] and "10" in r["error"]

    # 3. cancel by phone frees the slot
    r = await run(tools.cancel_appointment, phone_number="9876543210", phone_confirmed=True)
    assert r["ok"] and r["cancelled"], r
    free = {s["slot_id"] for s in store.find_availability(speciality="skin")["results"][0]["open_slots"]}
    assert slot in free

    r = await run(tools.cancel_appointment, phone_number="9876543210", phone_confirmed=True)
    assert not r["ok"] and "No upcoming" in r["error"]

    print("all tool checks passed")
    store.DB_PATH.unlink()


asyncio.run(main())
