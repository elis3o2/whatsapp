from pydantic import BaseModel, Field, ConfigDict
from typing import Optional

class CommonSuccessModel(BaseModel):
    code: int = Field(..., example=0)
    id: str  = Field(..., example="ABCD1234")
    status: str = Field(..., example="OK")
    from_user: str = Field(..., alias="from", example="5491199999999")
    to: str = Field(..., example="5491123456789")
    time: str = Field(..., example="2026-02-26T14:00:00")
    session: str = Field(..., example="a")

    model_config = ConfigDict(
        validate_by_name=True,
        json_schema_extra={
            "example": {
                "code": 0,
                "id": "ABCD1234",
                "status": "OK",
                "from": "5491199999999",
                "to": "5491123456789",
                "time": "2026-02-26T14:00:00",
                "session": "a"
            }
        }
    )

class ErrorModel(BaseModel):
    code: int = Field(..., example=-1)
    error: str = Field(..., example="Faltan datos")


class EnviarMensajeModel(BaseModel):
    numero: str = Field(..., description="Número destino", example="5491123456789")
    texto: str = Field(..., description="Texto a enviar", example="Hola mundo")
    session: Optional[str] = Field(None, description="Session (opcional). Si se omite, se usa round-robin", example="a")


class EnviarUbicacionModel(BaseModel):
    lat: float = Field(..., description="Latitud", example=-32.946368052145466)
    lon: float = Field(..., description="Longitud", example=-60.651289)
    numero: str = Field(..., description="Número destino", example="5491123456789")
    session: Optional[str] = Field(None, description="Session (opcional). Si se omite, se usa round-robin", example="a")

class EnviarArchivo(BaseModel):
    numero: str = Field(description="Número destino", example="5491123456789")
    texto: Optional[str] = Field(None, description="Texto a enviar (opcional).", example="Aca esta tu archivo")
    session: Optional[str] = Field(None, description="Session (opcional). Si se omite, se usa round-robin", example="a")

class EnviarEsperarModel(BaseModel):
    numero: str = Field(description="Número destino", example="5491123456789")
    texto: Optional[str] = Field(None, description="Texto a enviar (opcional).", example="Aca esta tu archivo")
    session: Optional[str] = Field(None, description="Session (opcional). Si se omite, se usa round-robin", example="a")

class StartFlowModel(BaseModel):
    flowName: str = Field(..., description="Nombre del flow", example="confirmacion-turno")
    numero: str = Field(..., description="Número destino",example="5491123456789")
    endpoint: str = Field(..., description="Endpoint callback", example="http://localhost:3050/recibir")
    session: Optional[str] = Field(None, description="Session (opcional). Si se omite, se usa round-robin", example="a")

class MensajeResponse(BaseModel):
    id: str = Field(..., example="ABCD1234")
    ack: int = Field(..., example=1)
    from_user: str = Field(..., alias="from", example="5491199999999")
    to: str = Field(..., example="5491123456789")
    time: str = Field(..., example="2026-02-13T12:34:56")
    session: str = Field(..., example="a")


