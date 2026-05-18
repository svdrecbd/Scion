import { NextResponse } from "next/server";
import {
  isAdvisoryReviewStatus,
  updateAdvisoryFindingReview,
} from "../../../../lib/public-pilot";

export const dynamic = "force-dynamic";

function formValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const slug = formValue(formData, "slug");
  const findingId = formValue(formData, "finding_id");
  const reviewStatus = formValue(formData, "review_status");
  const publicNoticeCandidate = formValue(formData, "public_notice_candidate") === "true";
  const redirectUrl = new URL("/pilot/review", request.url);

  if (!slug || !findingId || !isAdvisoryReviewStatus(reviewStatus)) {
    redirectUrl.searchParams.set("error", "invalid-review-request");
    return NextResponse.redirect(redirectUrl, 303);
  }

  try {
    await updateAdvisoryFindingReview({
      slug,
      findingId,
      reviewStatus,
      publicNoticeCandidate,
    });
    redirectUrl.searchParams.set("updated", findingId);
    redirectUrl.hash = findingId;
  } catch (error) {
    redirectUrl.searchParams.set(
      "error",
      error instanceof Error ? error.message : "review-update-failed"
    );
  }

  return NextResponse.redirect(redirectUrl, 303);
}
