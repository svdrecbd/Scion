class DatabaseUnavailableError(RuntimeError):
    """Raised when the API cannot reach its configured database."""


class StartupCheckError(RuntimeError):
    """Raised when required startup prerequisites are missing."""


class PressureLimitError(RuntimeError):
    """Raised when a guarded endpoint is already serving too many heavy requests."""

    def __init__(self, detail: str, *, retry_after_seconds: int) -> None:
        super().__init__(detail)
        self.retry_after_seconds = retry_after_seconds


class ExportLimitError(RuntimeError):
    """Raised when an export request exceeds the configured safety limit."""

    def __init__(self, detail: str, *, row_limit: int) -> None:
        super().__init__(detail)
        self.row_limit = row_limit
