"""AI health advisor: Gemini answers questions using our own data through function calling."""

import asyncio
import os
import time

from fastapi import HTTPException
from google import genai
from google.genai import types

MAX_TOOL_ROUNDS = 5
TOOL_TIMEOUT_S = 25
GEMINI_TIMEOUT_MS = 30_000
PROMPT = """You are BreathEasy's outdoor-exercise and air-quality advisor for India.
Only answer questions about weather, air quality (India's National AQI, NAQI) and when or where to walk, jog, run or cycle outdoors; politely decline anything else.
Never guess numbers. Look places up with find_place, then use hourly_outlook and safe_spots_near. Quote the NAQI, its dominant pollutant (written like PM2.5 or O3) and the local time you mean.
Times are local to the place. The first hourly_outlook row is the current hour; a time such as "6 PM" with no day means the first matching row from the start of the list.
Never diagnose or suggest medication; for health concerns, tell the user to follow their doctor's advice or asthma action plan.
Each hourly_outlook row has an "advice" field. For any question about going outside, include the advice of the hour being asked about, copied word for word, whatever the NAQI. Never change, soften or contradict it, and never add your own verdict. You are warm and friendly in anything you add around it.
Reply in plain text without markdown, in at most 150 words, and end with "Not medical advice."
User profile: {profile}.
The user's map is centred on lat {lat}, lon {lon}. Current UTC time: {now}."""


async def reply(messages, profile, lat, lon, tools):
    """Answer the latest message. tools are async functions Gemini may call; their docstrings describe them."""
    if not os.getenv("GEMINI_API_KEY"):
        raise HTTPException(503, "The AI advisor is not configured.")
    config = types.GenerateContentConfig(
        system_instruction=PROMPT.format(profile=profile.model_dump(), lat=round(lat, 4),
                                         lon=round(lon, 4), now=time.strftime("%Y-%m-%d %H:%M", time.gmtime())),
        tools=tools,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    by_name = {f.__name__: f for f in tools}
    contents = [types.Content(role=m.role, parts=[types.Part(text=m.text)]) for m in messages]
    async with genai.Client(api_key=os.getenv("GEMINI_API_KEY"), http_options=types.HttpOptions(timeout=GEMINI_TIMEOUT_MS)).aio as client:
        for _ in range(MAX_TOOL_ROUNDS):
            response = await client.models.generate_content(
                model=os.getenv("GEMINI_MODEL") or "gemini-flash-lite-latest", contents=contents, config=config)
            if not response.function_calls:
                return response.text or "Sorry, I couldn't answer that. Please try rephrasing."
            contents.append(response.candidates[0].content)  # keeps the model's call (and thought signature)
            results = []
            for call in response.function_calls:
                try:
                    result = await asyncio.wait_for(by_name[call.name](**(call.args or {})), TOOL_TIMEOUT_S)
                except Exception as e:  # noqa: BLE001 - report tool failures to the model so it can explain or retry
                    result = {"error": getattr(e, "detail", None) or str(e) or type(e).__name__}
                results.append(types.Part.from_function_response(name=call.name, response={"result": result}))
            contents.append(types.Content(role="user", parts=results))
    return "Sorry, that needed too many lookups. Please ask something more specific."
