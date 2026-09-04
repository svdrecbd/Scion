import { csvDocument } from "../../../../../../lib/csv";
import { experimentPlan } from "../../../../../../lib/corpus";
import type { DatasetRecord } from "../../../../../../lib/types";

export const dynamic = "force-dynamic";

function authorKey(dataset: DatasetRecord): string {
  return (dataset.source_study_id ?? "").replace("et al.", "").replace("et al", "").trim().split(" ")[0].toLowerCase() || dataset.dataset_id;
}

function publicRank(status: DatasetRecord["public_data_status"]): number {
  return status === "complete" ? 2 : status === "partial" ? 1 : 0;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const organelles = params.get("organelles") ?? "";
  if (!organelles.trim()) return Response.json({ detail: "At least one organelle is required." }, { status: 400 });

  const analysis = experimentPlan({
    organelles,
    res: params.get("res"),
    ss: params.get("ss"),
    cell_type: params.get("cell_type"),
    metric: params.get("metric"),
    comparator_class: params.get("comparator_class"),
    family: params.get("family")
  });
  const query = (params.get("precedent_query") ?? "").trim().toLowerCase();
  const publicState = params.get("precedent_public") ?? "";
  const sort = params.get("precedent_sort") ?? "year_desc";

  const datasets = analysis.precedents
    .filter((dataset) => !publicState || dataset.public_data_status === publicState)
    .filter((dataset) => !query || [
      dataset.dataset_id, dataset.source_study_id, dataset.publication_pmid, dataset.paper_title, dataset.source,
      dataset.cell_type, dataset.species, dataset.modality, dataset.comparator_class, dataset.comparator_detail,
      ...dataset.organelles, ...dataset.metric_families
    ].filter(Boolean).join(" ").toLowerCase().includes(query))
    .sort((left, right) => {
      if (sort === "year_asc") return left.year - right.year || left.dataset_id.localeCompare(right.dataset_id);
      if (sort === "author_asc") return authorKey(left).localeCompare(authorKey(right)) || right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
      if (sort === "sample_desc") return (right.sample_size ?? -1) - (left.sample_size ?? -1) || right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
      if (sort === "res_asc") return (left.lateral_resolution_nm ?? Infinity) - (right.lateral_resolution_nm ?? Infinity) || right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
      if (sort === "public_first") return publicRank(right.public_data_status) - publicRank(left.public_data_status) || right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
      return right.year - left.year || left.dataset_id.localeCompare(right.dataset_id);
    });

  const header = [
    "Dataset ID", "Study", "PMID", "Paper Title", "Year", "Journal", "Cell Type", "Species", "Modality", "Modality Family",
    "Res XY (nm)", "Res Z (nm)", "Sample Size", "Organelles", "Metrics", "Comparator Class", "Comparator Detail", "Public Data Status", "Publication URL"
  ];
  const rows = datasets.map((dataset) => [
    dataset.dataset_id, dataset.source_study_id, dataset.publication_pmid, dataset.paper_title, dataset.year, dataset.source,
    dataset.cell_type, dataset.species, dataset.modality, dataset.modality_family, dataset.lateral_resolution_nm,
    dataset.axial_resolution_nm, dataset.sample_size, dataset.organelles.join("; "), dataset.metric_families.join("; "),
    dataset.comparator_class, dataset.comparator_detail, dataset.public_data_status, dataset.source_publication_url
  ]);
  return new Response(csvDocument([header, ...rows]), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": "attachment; filename=cell_anatomy_plan_precedents.csv",
      "Content-Type": "text/csv; charset=utf-8",
      "X-Scion-Export-Count": String(datasets.length)
    }
  });
}
