from fastapi import APIRouter

from app.readiness import readiness_snapshot

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
def health_ready() -> dict[str, int | str]:
    return readiness_snapshot()
