"""SQLite-backed mock data for the clinic: doctors, slots and appointments.

Everything here is plain synchronous sqlite3. Queries are tiny, so calling
them from async tool handlers is fine for a demo.
"""

from __future__ import annotations

import difflib
import random
import re
import sqlite3
import string
from datetime import date, datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "clinic.db"
DAYS_AHEAD = 6  # working days of slots to generate

DOCTORS = [
    # id, name, speciality, morning?, evening?
    ("ananya-rao", "Dr. Ananya Rao", "General Physician", True, True),
    ("vikram-mehta", "Dr. Vikram Mehta", "Cardiologist", True, False),
    ("sara-khan", "Dr. Sara Khan", "Dermatologist", False, True),
    ("arjun-nair", "Dr. Arjun Nair", "Orthopaedic Surgeon", True, True),
    ("meera-iyer", "Dr. Meera Iyer", "Paediatrician", True, False),
    ("rohan-kapoor", "Dr. Rohan Kapoor", "ENT Specialist", False, True),
]

MORNING = ["10:00", "10:30", "11:00", "11:30", "12:00"]
EVENING = ["16:00", "16:30", "17:00", "17:30", "18:00"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    speciality TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    starts_at TEXT NOT NULL,           -- local ISO datetime, minute precision
    is_booked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL REFERENCES slots(id),
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL,              -- 'booked' | 'cancelled'
    source TEXT NOT NULL DEFAULT 'voice',
    created_at TEXT NOT NULL,
    cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments(phone);
"""


class StoreError(Exception):
    """A user-facing problem the agent should explain to the caller."""


# ---------------------------------------------------------------- helpers


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalize_phone(raw: str) -> str:
    """Keep digits only and strip an Indian country code. Must end up 10 digits."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        raise StoreError(
            f"'{raw}' has {len(digits)} digits; a mobile number needs 10. Ask the caller to repeat it."
        )
    return digits


def spoken_phone(phone: str) -> str:
    """'9876543210' -> '9 8 7 6 5, 4 3 2 1 0' so TTS reads digit by digit."""
    return " ".join(phone[:5]) + ", " + " ".join(phone[5:])


def human_time(iso: str) -> str:
    dt = datetime.fromisoformat(iso)
    return dt.strftime("%A %d %B, %I:%M %p").replace(" 0", " ")


def _working_days(start: date, n: int) -> list[date]:
    days, d = [], start
    while len(days) < n:
        if d.weekday() != 6:  # clinic closed on Sundays
            days.append(d)
        d += timedelta(days=1)
    return days


def _appt_id(c: sqlite3.Connection) -> str:
    """A short, speakable booking reference like LK-4821 that isn't already in use."""
    for _ in range(20):
        candidate = "LK-" + "".join(random.choices(string.digits, k=4))
        if not c.execute("SELECT 1 FROM appointments WHERE id = ?", (candidate,)).fetchone():
            return candidate
    # 20 clashes in a row means the 4-digit space is crowded: fall back to 6 digits.
    return "LK-" + "".join(random.choices(string.digits, k=6))


# ---------------------------------------------------------------- seeding


def init_db(reset: bool = False) -> None:
    """Create tables and seed doctors + slots for the next few working days."""
    if reset and DB_PATH.exists():
        DB_PATH.unlink()
    with _conn() as c:
        c.executescript(SCHEMA)
        if c.execute("SELECT COUNT(*) FROM doctors").fetchone()[0] == 0:
            c.executemany(
                "INSERT INTO doctors(id, name, speciality) VALUES (?,?,?)",
                [(d[0], d[1], d[2]) for d in DOCTORS],
            )
        _ensure_slots(c)
        if reset:
            _seed_existing_bookings(c)


def _ensure_slots(c: sqlite3.Connection) -> None:
    """Top up slots so there are always DAYS_AHEAD working days from today."""
    for day in _working_days(date.today(), DAYS_AHEAD):
        for doc_id, _, _, morning, evening in DOCTORS:
            times = (MORNING if morning else []) + (EVENING if evening else [])
            for t in times:
                slot_id = f"{doc_id}-{day:%m%d}-{t.replace(':', '')}"
                # ~1 in 6 slots is pre-taken by walk-ins so the grid looks lived-in.
                # Seeded by slot id, so it's stable across restarts.
                taken = random.Random(slot_id).random() < 0.17
                c.execute(
                    "INSERT OR IGNORE INTO slots(id, doctor_id, starts_at, is_booked) VALUES (?,?,?,?)",
                    (slot_id, doc_id, f"{day.isoformat()}T{t}", int(taken)),
                )


def _seed_existing_bookings(c: sqlite3.Connection) -> None:
    """A couple of earlier bookings so the appointments table isn't empty."""
    samples = [("Kavya Sharma", "9811122233"), ("Rahul Verma", "9988776655")]
    free = c.execute(
        "SELECT id, doctor_id FROM slots WHERE is_booked = 0 AND starts_at > ? ORDER BY starts_at LIMIT 40",
        (datetime.now().isoformat(timespec="minutes"),),
    ).fetchall()
    for (name, phone), slot in zip(samples, free[5::17]):
        c.execute("UPDATE slots SET is_booked = 1 WHERE id = ?", (slot["id"],))
        c.execute(
            "INSERT INTO appointments(id, slot_id, doctor_id, patient_name, phone, status, source, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (_appt_id(c), slot["id"], slot["doctor_id"], name, phone, "booked", "desk", _now()),
        )


# ---------------------------------------------------------------- reads


def list_doctors() -> list[dict]:
    with _conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM doctors ORDER BY name")]


def doctors_with_slots() -> list[dict]:
    """For the dashboard: every doctor with every upcoming slot and its state."""
    now = datetime.now().isoformat(timespec="minutes")
    with _conn() as c:
        docs = [dict(r) for r in c.execute("SELECT * FROM doctors ORDER BY name")]
        for d in docs:
            d["slots"] = [
                {"id": r["id"], "starts_at": r["starts_at"], "is_booked": bool(r["is_booked"])}
                for r in c.execute(
                    "SELECT * FROM slots WHERE doctor_id = ? AND starts_at > ? ORDER BY starts_at",
                    (d["id"], now),
                )
            ]
        return docs


def list_appointments() -> list[dict]:
    with _conn() as c:
        rows = c.execute(
            """SELECT a.*, s.starts_at, d.name AS doctor_name, d.speciality
               FROM appointments a
               JOIN slots s ON s.id = a.slot_id
               JOIN doctors d ON d.id = a.doctor_id
               ORDER BY a.created_at DESC"""
        )
        return [dict(r) for r in rows]


def _match_doctors(c: sqlite3.Connection, doctor_name: str | None, speciality: str | None) -> list[dict]:
    docs = [dict(r) for r in c.execute("SELECT * FROM doctors")]
    if doctor_name:
        q = re.sub(r"\b(dr|doctor)\.?\b", "", doctor_name.lower()).strip()
        hits = [d for d in docs if q and any(part in d["name"].lower() for part in q.split())]
        if not hits:  # fuzzy fallback for STT mishearings ("Anaya Rao")
            names = {d["name"].lower().replace("dr. ", ""): d for d in docs}
            close = difflib.get_close_matches(q, names.keys(), n=2, cutoff=0.5)
            hits = [names[n] for n in close]
        docs = hits
    if speciality:
        s = speciality.lower()
        aliases = {
            "heart": "cardio", "skin": "derma", "bone": "ortho", "child": "paediat",
            "kids": "paediat", "pediat": "paediat", "ear": "ent", "nose": "ent",
            "throat": "ent", "general": "general", "fever": "general",
        }
        key = next((v for k, v in aliases.items() if k in s), s[:5])
        docs = [d for d in docs if key in d["speciality"].lower()]
    return docs


def find_availability(
    doctor_name: str | None = None, speciality: str | None = None, on_date: str | None = None
) -> dict:
    now = datetime.now().isoformat(timespec="minutes")
    with _conn() as c:
        if not doctor_name and not speciality:
            return {
                "doctors": [
                    {"name": d["name"], "speciality": d["speciality"]}
                    for d in c.execute("SELECT * FROM doctors ORDER BY speciality")
                ],
                "note": "No doctor or speciality given. Ask the caller which one they want.",
            }
        docs = _match_doctors(c, doctor_name, speciality)
        if not docs:
            all_docs = [f"{r['name']} ({r['speciality']})" for r in c.execute("SELECT * FROM doctors")]
            raise StoreError("No matching doctor. Doctors at the clinic: " + "; ".join(all_docs))

        out = []
        for d in docs:
            sql = "SELECT * FROM slots WHERE doctor_id = ? AND is_booked = 0 AND starts_at > ?"
            args: list = [d["id"], now]
            if on_date:
                sql += " AND substr(starts_at, 1, 10) = ?"
                args.append(on_date)
            sql += " ORDER BY starts_at LIMIT 8"
            slots = [
                {"slot_id": r["id"], "when": human_time(r["starts_at"])}
                for r in c.execute(sql, args)
            ]
            out.append({"doctor_id": d["id"], "doctor": d["name"], "speciality": d["speciality"], "open_slots": slots})
        return {"date_filter": on_date, "results": out}


def slot_starts(slot_ids: list[str]) -> dict[str, str]:
    """slot_id -> starts_at, for telling the dashboard what the agent is looking at."""
    if not slot_ids:
        return {}
    with _conn() as c:
        q = f"SELECT id, starts_at FROM slots WHERE id IN ({','.join('?' * len(slot_ids))})"
        return {r["id"]: r["starts_at"] for r in c.execute(q, slot_ids)}


# ---------------------------------------------------------------- writes


def book(slot_id: str, phone: str, patient_name: str) -> dict:
    phone = normalize_phone(phone)
    with _conn() as c:
        slot = c.execute(
            "SELECT s.*, d.name AS doctor_name, d.speciality FROM slots s JOIN doctors d ON d.id = s.doctor_id WHERE s.id = ?",
            (slot_id,),
        ).fetchone()
        if not slot:
            raise StoreError("That slot id doesn't exist. Check availability again and use a slot_id from the results.")
        if slot["is_booked"]:
            raise StoreError("That slot was just taken. Offer the caller another time.")
        if slot["starts_at"] <= datetime.now().isoformat(timespec="minutes"):
            raise StoreError("That slot is in the past. Offer an upcoming one.")
        # Only claim the slot if it's still free, so two callers can't both get it.
        claimed = c.execute("UPDATE slots SET is_booked = 1 WHERE id = ? AND is_booked = 0", (slot_id,))
        if claimed.rowcount == 0:
            raise StoreError("That slot was just taken. Offer the caller another time.")
        appt_id = _appt_id(c)
        c.execute(
            "INSERT INTO appointments(id, slot_id, doctor_id, patient_name, phone, status, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (appt_id, slot_id, slot["doctor_id"], patient_name.strip().title(), phone, "booked", _now()),
        )
    return {
        "appointment_id": appt_id,
        "slot_id": slot_id,
        "doctor": slot["doctor_name"],
        "speciality": slot["speciality"],
        "when": human_time(slot["starts_at"]),
        "starts_at": slot["starts_at"],
        "patient_name": patient_name.strip().title(),
        "phone": phone,
    }


def upcoming_for_phone(phone: str) -> list[dict]:
    phone = normalize_phone(phone)
    now = datetime.now().isoformat(timespec="minutes")
    with _conn() as c:
        rows = c.execute(
            """SELECT a.id, a.slot_id, a.patient_name, s.starts_at, d.name AS doctor_name
               FROM appointments a JOIN slots s ON s.id = a.slot_id JOIN doctors d ON d.id = a.doctor_id
               WHERE a.phone = ? AND a.status = 'booked' AND s.starts_at > ?
               ORDER BY s.starts_at""",
            (phone, now),
        )
        return [
            {"appointment_id": r["id"], "slot_id": r["slot_id"], "starts_at": r["starts_at"],
             "doctor": r["doctor_name"], "when": human_time(r["starts_at"]), "patient_name": r["patient_name"]}
            for r in rows
        ]


def cancel(phone: str, appointment_id: str | None = None) -> dict:
    phone = normalize_phone(phone)
    upcoming = upcoming_for_phone(phone)
    if not upcoming:
        raise StoreError(f"No upcoming appointment is booked under {spoken_phone(phone)}.")
    if appointment_id:
        target = next((a for a in upcoming if a["appointment_id"].lower() == appointment_id.lower()), None)
        if not target:
            ids = ", ".join(f"{a['appointment_id']} with {a['doctor']} on {a['when']}" for a in upcoming)
            raise StoreError(f"That appointment isn't under this number. Bookings under it: {ids}.")
    elif len(upcoming) > 1:
        return {"needs_choice": True, "appointments": upcoming,
                "note": "More than one booking. Ask which one to cancel, then call again with appointment_id."}
    else:
        target = upcoming[0]
    with _conn() as c:
        c.execute(
            "UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
            (_now(), target["appointment_id"]),
        )
        c.execute("UPDATE slots SET is_booked = 0 WHERE id = ?", (target["slot_id"],))
    return {"cancelled": True, **target}
