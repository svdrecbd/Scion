from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.errors import DatabaseUnavailableError
from app.routes.datasets import router as datasets_router
from app.routes.health import router as health_router

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="API for Scion, a structured lookup and comparison layer for whole-cell datasets.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix=settings.api_prefix)
app.include_router(datasets_router, prefix=settings.api_prefix)


@app.exception_handler(DatabaseUnavailableError)
def handle_database_unavailable(_, exc: DatabaseUnavailableError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "Scion API is running"}
