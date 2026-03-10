
COMMON_ERROR_EXAMPLES = {
    "faltan_datos": {"summary": "Faltan datos", "value": {"code": -1, "error": "Faltan datos"}},
    "numero_invalido": {"summary": "Número inválido", "value": {"code": -2, "error": "Número inválido"}},
    "numero_sin_whatsapp": {"summary": "Número sin whatsapp", "value": {"code": -3, "error": "Número sin whatsapp"}},
    "client_not_ready": {"summary": "Client not ready", "value": {"code": -4, "error": "Client not ready"}},
    "fallo_envio": {"summary": "Falló el envío", "value": {"code": -5, "error": "Falló el envío"}},
    "sesion_invalida": {"summary": "Sesión desconocida", "value":{"code": -6, "error": "Sesión desconocida"} },
    "sesion_desconectada": {"summary": "Sesión desconectada", "value":{"code": -7, "error": "Sesión desconectada"} },
    "fallo_sesiones": {"summary": "Fallo en sesiones", "value":{"code": -8 , "error": "Fallaron todas las sesiones"}}
}

# Diccionario de responses reutilizable:
COMMON_RESPONSES = {
    200: {
        "description": "Envío procesado (respuesta del backend)",
        "content": {
            "application/json": {
                "example":{
                            "code": 0,
                            "id": "ABCD1234",
                            "status": "OK",
                            "from": "5491199999999",
                            "to": "5491123456789",
                            "time": "2026-02-26T14:00:00",
                            "session": "a",
                            "ack": 0
                }
            }
        }
    },
    400: {
        "description": "Bad Request — parámetros faltantes o inválidos",
        "content": {
            "application/json": {
                "examples": {
                    "numero_invalido": COMMON_ERROR_EXAMPLES["numero_invalido"]
                }
            }
        }
    },
    422: {
        "description": "Unprocessable Entity — número sin WhatsApp",
        "content": {
            "application/json": {
                "example": COMMON_ERROR_EXAMPLES["numero_sin_whatsapp"]["value"]
            }
        }
    },
    503: {
        "description": "Service Unavailable — cliente no listo",
        "content": {
            "application/json": {
                "example": COMMON_ERROR_EXAMPLES["client_not_ready"]["value"]
            }
        }
    },
    500: {
        "description": "Internal Server Error — fallo de envío",
        "content": {
            "application/json": {
                "example": COMMON_ERROR_EXAMPLES["fallo_envio"]["value"]
            }
        }
    },
}


COMMON_RESPONSES_POST = {
    **COMMON_RESPONSES,
    400: {
        **COMMON_RESPONSES[400],
        "content": {
                "application/json": {
                    "examples": {
                        **COMMON_RESPONSES[400]["content"]["application/json"]["examples"],
                        "faltan_datos": COMMON_ERROR_EXAMPLES["faltan_datos"],                    
                    }
                }
            }
    },
    502: {
        "description": "Bad Gateway - fallo sesiones",
        "content": {
            "application/json": {
                "example": COMMON_ERROR_EXAMPLES['fallo_sesiones']["value"]

            }
        },
    }
}


COMMON_RESPONSES_SESSION = {
    **COMMON_RESPONSES,
    400: {
        **COMMON_RESPONSES[400],
        "content": {
            "application/json": {
                "examples": {
                    **COMMON_RESPONSES[400]["content"]["application/json"]["examples"],
                    "sesion_invalida": COMMON_ERROR_EXAMPLES["sesion_invalida"],
                }
            }
        },
    },
    502: {
        "description": "Bad Gateway - sesión desconectada",
        "content": {
            "application/json": {
                "example":  COMMON_ERROR_EXAMPLES["sesion_desconectada"]["value"]
            }
        },
    }
}



SESSION_STATUS_EXAMPLE = [
    {"session": "a", "state": "CONNECTED", "port": 3021},
    {"session": "b", "state": "error", "port": 3022},
    {"session": "c", "state": "error", "port": 3023},
    {"session": "d", "state": "error", "port": 3024},
    {"session": "e", "state": "error", "port": 3025},
]


RESPONSES_STATUS = {
    200: {
        "description": "Estado de todas las sesiones",
        "content": {
            "application/json": {
                "example": SESSION_STATUS_EXAMPLE
            }
        }
    }
}