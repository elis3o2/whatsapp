import threading
import requests
from io import BytesIO
from typing import Optional
from fastapi.responses import Response, JSONResponse
from responses import COMMON_ERROR_EXAMPLES
from config import SESSIONS, SESSIONS_PORT, HOST, FORWARD_TIMEOUT, HOP_BY_HOP_HEADERS


# ── Least-sends state ──────────────────────────────────────────────────────────
send_count_lock = threading.Lock()
session_send_count: dict[str, int] = {s: 0 for s in SESSIONS}
PORT_TO_SESSION: dict[int, str] = {v: k for k, v in SESSIONS_PORT.items()}


def _increment_send_count(port: int, method: str) -> None:
    if method.upper() == "GET":
        return
    session = PORT_TO_SESSION.get(port)
    if session:
        with send_count_lock:
            session_send_count[session] += 1


def build_ports_priority_queue(preferred_session: Optional[str]) -> list[int]:
    """
    Devuelve la lista de puertos ordenada por menor cantidad de envíos (least-sends).
    Si se especifica una sesión válida, la mueve al frente sin alterar el resto.
    """
    with send_count_lock:
        ordered = sorted(SESSIONS, key=lambda s: session_send_count[s])

    if preferred_session and preferred_session in SESSIONS:
        ordered.remove(preferred_session)
        ordered.insert(0, preferred_session)

    return [SESSIONS_PORT[s] for s in ordered]


# ── Helpers ────────────────────────────────────────────────────────────────────

def filter_response_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP_HEADERS}


def _build_request_payload(
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
) -> tuple[Optional[dict], Optional[bytes | dict]]:
    if not files_for_requests:
        return None, data_bytes

    ff = files_for_requests.get('__form_fields__')
    form_fields = ff.get('form_fields') if ff else None

    files_payload = None
    if any(k != '__form_fields__' for k in files_for_requests):
        files_payload = {
            fieldname: (
                info.get('filename') or fieldname,
                BytesIO(info.get('content', b'')),
                info.get('content_type'),
            )
            for fieldname, info in files_for_requests.items()
            if fieldname != '__form_fields__'
        }

    return files_payload, form_fields or None


# ── Forwarding ─────────────────────────────────────────────────────────────────

def _make_requests_loop_and_forward(
    method: str,
    path: str,
    headers: dict,
    params: dict,
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
    start_ports: list[int],
    result: dict,
) -> None:
    fwd_headers = {k: v for k, v in (headers or {}).items() if k.lower() != 'host'}
    files_payload, data_param = _build_request_payload(data_bytes, files_for_requests)
    last_error = None

    for port in start_ports:
        try:
            resp = requests.request(
                method=method,
                url=f"http://{HOST}:{port}{path}",
                headers=fwd_headers,
                params=params,
                data=data_param,
                files=files_payload,
                timeout=FORWARD_TIMEOUT,
                proxies={"http": None, "https": None},
            )

            if resp.status_code >= 500:
                last_error = f"HTTP {resp.status_code} from port {port}"
                continue

            _increment_send_count(port, method)  
            result['status_code'] = resp.status_code
            result['headers'] = dict(resp.headers)
            result['content'] = resp.content
            return

        except Exception as e:
            last_error = str(e)

    result['error'] = last_error or "No response from any backend"


def _make_request_single_port(
    method: str,
    path: str,
    headers: dict,
    params: Optional[dict],
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
    port: int,
    result: dict,
) -> None:
    fwd_headers = {k: v for k, v in (headers or {}).items() if k.lower() != 'host'}
    files_payload, data_param = _build_request_payload(data_bytes, files_for_requests)

    try:
        resp = requests.request(
            method=method,
            url=f"http://{HOST}:{port}{path}",
            headers=fwd_headers,
            params=params,
            data=data_param,
            files=files_payload,
            timeout=FORWARD_TIMEOUT,
            proxies={"http": None, "https": None},
        )
        _increment_send_count(port, method)          # ← solo si no hubo excepción
        result['status_code'] = resp.status_code
        result['headers'] = dict(resp.headers)
        result['content'] = resp.content

    except Exception as e:
        result['error'] = str(e)


# ── Thread runners ─────────────────────────────────────────────────────────────

def run_forward_thread_and_get_response(
    method: str,
    path: str,
    headers: dict,
    params: dict,
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
    start_ports: list[int],
) -> Response | JSONResponse:
    result = {}
    th = threading.Thread(
        target=_make_requests_loop_and_forward,
        args=(method, path, headers, params, data_bytes, files_for_requests, start_ports, result),
        daemon=True,
    )
    th.start()
    th.join()

    if 'error' in result:
        return JSONResponse(
            {"error": "No backend available or all backends failed", "detail": result['error']},
            status_code=502,
        )

    return Response(
        content=result.get('content', b''),
        status_code=result.get('status_code'),
        headers=filter_response_headers(result.get('headers', {})),
    )


def run_single_port_thread_and_get_response(
    method: str,
    path: str,
    headers: dict,
    params: Optional[dict],
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
    port: int,
) -> Response | JSONResponse:
    result = {}
    th = threading.Thread(
        target=_make_request_single_port,
        args=(method, path, headers, params, data_bytes, files_for_requests, port, result),
        daemon=True,
    )
    th.start()
    th.join()

    if 'error' in result:
        print("ERROR EN REQUEST:", result)
        return JSONResponse(COMMON_ERROR_EXAMPLES["sesion_invalida"]['value'], status_code=502)

    return Response(
        content=result.get('content', b''),
        status_code=result.get('status_code'),
        headers=filter_response_headers(result.get('headers', {})),
    )