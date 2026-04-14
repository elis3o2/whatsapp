import threading
import requests
from io import BytesIO
from typing import Optional
from fastapi.responses import Response, JSONResponse
from responses import COMMON_ERROR_EXAMPLES
from config import SESSIONS, SESSIONS_PORT, HOST, FORWARD_TIMEOUT, HOP_BY_HOP_HEADERS


# round-robin state
rr_index = 0
rr_lock = threading.Lock()


def get_next_rr_index() -> int:
    global rr_index
    with rr_lock:
        idx = rr_index % len(SESSIONS)
        rr_index += 1
        return idx


def build_ports_priority_queue(preferred_session: Optional[str]) -> list[int]:
    """
    Devuelve la lista de puertos ordenada para el intento actual:
    - Empieza en el siguiente índice round-robin.
    - Si se especifica una sesión válida, la mueve al frente
      sin alterar el orden del resto (failover correcto).
    """
    start_idx = get_next_rr_index()
    ordered_sessions = SESSIONS[start_idx:] + SESSIONS[:start_idx]

    if preferred_session and preferred_session in SESSIONS:
        ordered_sessions.remove(preferred_session)
        ordered_sessions.insert(0, preferred_session)

    return [SESSIONS_PORT[s] for s in ordered_sessions]


def filter_response_headers(headers: dict) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in HOP_BY_HOP_HEADERS}


def _build_request_payload(
    data_bytes: Optional[bytes],
    files_for_requests: Optional[dict],
) -> tuple[Optional[dict], Optional[bytes | dict]]:
    """
    Devuelve (files_payload, data_param) listos para requests.request().
    Centraliza la lógica duplicada que había en ambas funciones de forwarding.
    """
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
    """
    Intenta reenviar la request en el orden de start_ports (round-robin + failover).
    Guarda la primera respuesta con status < 500.
    """
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
    """
    Reenvía únicamente al puerto indicado (sin failover).
    Guarda la respuesta aunque sea 5xx.
    """
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
        result['status_code'] = resp.status_code
        result['headers'] = dict(resp.headers)
        result['content'] = resp.content

    except Exception as e:
        result['error'] = str(e)


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