import { csvDocument } from "../../../../lib/csv";
import { filterDatasets, type CorpusFilters } from "../../../../lib/corpus";

export const dynamic = "force-dynamic";

function download(body: string, filename: string, contentType: string, count: number) {
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": contentType,
      "X-Scion-Export-Count": String(count)
    }
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "csv";
  if (!["csv", "json", "bibtex"].includes(format)) {
    return Response.json({ detail: "Unsupported export format." }, { status: 400 });
  }

  const filters = Object.fromEntries(url.searchParams.entries()) as CorpusFilters;
  let datasets;
  try {
    datasets = filterDatasets(filters);
  } catch (error) {
    return Response.json({ detail: error instanceof Error ? error.message : "Invalid filters." }, { status: 400 });
  }

  if (format === "json") {
    return download(JSON.stringify(datasets, null, 2), "cell_anatomy_corpus_export.json", "application/json; charset=utf-8", datasets.length);
  }

  if (format === "bibtex") {
    const body = datasets.map((dataset) => {
      const lines = [
        `@article{${dataset.dataset_id.replaceAll("-", "")},`,
        `  title = {${dataset.paper_title}},`,
        `  author = {${dataset.source_study_id ?? dataset.source}},`,
        `  journal = {${dataset.source}},`,
        `  year = {${dataset.year}},`
      ];
      if (dataset.publication_pmid) lines.push(`  pmid = {${dataset.publication_pmid}},`);
      lines.push(`  note = {Indexed in the Cell Anatomy Corpus: ${dataset.title}}`, "}");
      return lines.join("\n");
    }).join("\n\n");
    return download(body, "cell_anatomy_corpus_export.bib", "text/plain; charset=utf-8", datasets.length);
  }

  const rows = datasets.map((dataset) => [
    dataset.dataset_id,
    dataset.title,
    dataset.paper_title,
    dataset.source_study_id,
    dataset.publication_pmid,
    dataset.year,
    dataset.source,
    dataset.species,
    dataset.cell_type,
    dataset.modality,
    dataset.lateral_resolution_nm,
    dataset.axial_resolution_nm,
    dataset.organelles.join("; "),
    dataset.metric_families.join("; "),
    dataset.public_data_status,
    dataset.included_status,
    dataset.source_publication_url,
    dataset.public_locator_urls?.join("; "),
    dataset.notes
  ]);
  const header = [
    "Dataset ID", "Title", "Paper Title", "Study", "PMID", "Year", "Journal", "Species", "Cell Type", "Modality",
    "Res XY (nm)", "Res Z (nm)", "Organelles", "Metrics", "Public Data Status", "Included Status", "Publication URL", "Public Data URLs", "Notes"
  ];
  return download(csvDocument([header, ...rows]), "cell_anatomy_corpus_export.csv", "text/csv; charset=utf-8", datasets.length);
}
