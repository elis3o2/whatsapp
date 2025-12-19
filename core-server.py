from fastapi import (
    FastAPI,
    Request,
    Query,
    Body,
    Form,
    File,
    UploadFile
)
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel
from typing import Optional
import threading
import requests
from io import BytesIO
import urllib.parse
import json

app = FastAPI()

# ----- CONFIG -----
HOST = "127.0.0.1"
SESSIONS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
SESSIONS_PORT = {
    "a": 3005, "b": 3006, "c": 3007, "d": 3008, "e": 3009,
    "f": 3010, "g": 3011, "h": 3012, "i": 3013, "j": 3014
}
FORWARD_TIMEOUT = 30
HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade"
}
# -------------------

rr_index = 0
rr_lock = threading.Lock()

# ---------- MODELOS ----------

class EnviarMensajeBody(BaseModel):
    numero: str
    texto: str


class EnviarUbicacionBody(BaseModel):
    lat: float
    lon: float
    numero: str


class EsperarBody(BaseModel):
    numero: str
    texto: str


# ---------- HELPERS ----------

def get_next_session_round_robin_index():
    global rr_index
    with rr_lock:
        idx = rr_index % len(SESSIONS)
        rr_index += 1
        return idx


def ports_list_order_from_index(start_idx: int):
    ordered_sessions = SESSIONS[start_idx:] + SESSIONS[:start_idx]
    return [SESSIONS_PORT[s] for s in ordered_sessions]


def filter_response_headers(headers):
    return {
        k: v for k, v in headers.items()
        if k.lower() not in HOP_BY_HOP_HEADERS
    }


def _extract_session_param_or_400(session: str):
    if session not in SESSIONS:
        return JSONResponse(
            {"error": f"Unknown session '{session}'"},
            status_code=400
        )
    return SESSIONS_PORT[session]

# ---------- FORWARDERS (sin cambios de lógica) ----------
# (idénticos a los tuyos, omitidos acá por brevedad)
# 👉 asumimos que _make_requests_loop_and_forward,
# _make_request_single_port,
# run_forward_thread_and_get_response,
# run_single_port_thread_and_get_response
# permanecen EXACTAMENTE IGUALES
# ------------------------------------------------------

# ---------- ROUTES ----------

# POST JSON
@app.post("/enviar-mensaje")
async def enviar_mensaje(
    body: EnviarMensajeBody,
    request: Request):
    start_ports = ports_list_order_from_index(
        get_next_session_round_robin_index()
    )

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=(await request.body()),
        files_for_requests=None,
        start_ports=start_ports,
    )


# POST multipart/form-data
@app.post("/enviar-archivo")
async def enviar_archivo(
    numero: str = Form(...),
    texto: Optional[str] = Form(None),
    archivo: Optional[UploadFile] = File(None),
    request: Request = None):
    form = await request.form()
    files_payload = {}
    form_fields = {}

    for k, v in form.items():
        if isinstance(v, UploadFile):
            files_payload[k] = {
                "filename": v.filename,
                "content": await v.read(),
                "content_type": v.content_type
            }
        else:
            form_fields[k] = v

    if files_payload:
        files_payload["__form_fields__"] = {"form_fields": form_fields}
        data_bytes = None
    else:
        data_bytes = urllib.parse.urlencode(form_fields).encode()

    start_ports = ports_list_order_from_index(
        get_next_session_round_robin_index()
    )

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=data_bytes,
        files_for_requests=files_payload,
        start_ports=start_ports
    )


@app.post("/enviar-ubicacion")
async def enviar_ubicacion(
    body: EnviarUbicacionBody,
    request: Request):
    start_ports = ports_list_order_from_index(
        get_next_session_round_robin_index()
    )

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=(await request.body()),
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post("/esperar")
async def esperar(
    body: EsperarBody,
    request: Request):
    start_ports = ports_list_order_from_index(
        get_next_session_round_robin_index()
    )

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=(await request.body()),
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post("/start_flow")
async def start_flow(
    flowName: str = Query(...),
    numero: str = Query(...),
    endpoint: str = Query(...),
    request: Request = None):
    data_bytes = await request.body()

    start_ports = ports_list_order_from_index(
        get_next_session_round_robin_index()
    )

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=data_bytes,
        files_for_requests=None,
        start_ports=start_ports
    )


# ---------- GET (Query SIEMPRE) ----------

@app.get("/respuesta")
async def respuesta(
    idMensaje: str = Query(...),
    session: str = Query(...),
    request: Request = None):
    port = _extract_session_param_or_400(session)
    if isinstance(port, JSONResponse):
        return port

    return run_single_port_thread_and_get_response(
        method="GET",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=None,
        files_for_requests=None,
        port=port
    )


@app.get("/estado")
async def estado(
    session: str = Query(...),
    id: str = Query(...),
    numero: str = Query(...),
    request: Request = None):
    port = _extract_session_param_or_400(session)
    if isinstance(port, JSONResponse):
        return port

    return run_single_port_thread_and_get_response(
        "GET",
        request.url.path,
        dict(request.headers),
        dict(request.query_params),
        None,
        None,
        port
    )


@app.get("/get_mensajes")
async def get_mensajes(
    session: str = Query(...),
    numero: str = Query(...),
    request: Request = None):
    port = _extract_session_param_or_400(session)
    if isinstance(port, JSONResponse):
        return port

    return run_single_port_thread_and_get_response(
        "GET",
        request.url.path,
        dict(request.headers),
        dict(request.query_params),
        None,
        None,
        port
    )


@app.get("/qr")
@app.get("/qr")
async def get_qr(
    session: str = Query(..., description="Sesión de WhatsApp"),
    request: Request = None):
    port = _extract_session_param_or_400(session)
    if isinstance(port, JSONResponse):
        return port

    return run_single_port_thread_and_get_response(
        method="GET",
        path=request.url.path,
        headers=dict(request.headers),
        params=dict(request.query_params),
        data_bytes=None,
        files_for_requests=None,
        port=port
    )


@app.get("/status")
async def status(
    session: str = Query(...),
    request: Request = None):
    port = _extract_session_param_or_400(session)
    if isinstance(port, JSONResponse):
        return port

    return run_single_port_thread_and_get_response(
        "GET",
        request.url.path,
        dict(request.headers),
        dict(request.query_params),
        None,
        None,
        port
    )


@app.get("/status-all")
async def status_all():
    results = []

    for session in SESSIONS:
        port = SESSIONS_PORT[session]
        result = {}

        _make_request_single_port(
            "GET",
            "/status",
            {},
            {"session": session},
            None,
            None,
            port,
            result
        )

        state = "unknown"
        if "content" in result:
            try:
                state = json.loads(result["content"]).get("state", "unknown")
            except Exception:
                pass

        results.append({
            "session": session,
            "state": state,
            "port": port
        })

    return results


@app.get("/")
async def root():
    return {"ok": True}
