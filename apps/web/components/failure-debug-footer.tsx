export function FailureDebugFooter({
  requestId,
  statusCode
}: {
  requestId?: string;
  statusCode?: number;
}) {
  if (!requestId && !statusCode) {
    return null;
  }

  return (
    <div className="failure-debug-footer">
      <span className="failure-debug-label">Operator details</span>
      {statusCode ? <span>status: {statusCode}</span> : null}
      {requestId ? <span>request_id: {requestId}</span> : null}
    </div>
  );
}
