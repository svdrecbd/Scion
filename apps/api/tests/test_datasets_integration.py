from __future__ import annotations

from fastapi.testclient import TestClient

from app.observability import REQUEST_ID_HEADER


def test_readiness_route_reports_seeded_database(integration_client: TestClient) -> None:
    response = integration_client.get(
        "/api/health/ready",
        headers={REQUEST_ID_HEADER: "ready-check"},
    )
    assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "ready"
    assert payload["dataset_records"] == 118
    assert payload["applied_migrations"] >= 1
    assert response.headers["x-request-id"] == "ready-check"


def test_seeded_search_reads_from_postgres(integration_client: TestClient) -> None:
    unfiltered_response = integration_client.get("/api/datasets", params={"limit": 1})
    assert unfiltered_response.status_code == 200
    assert unfiltered_response.json()["total"] == 118
    assert len(unfiltered_response.json()["results"]) == 1

    filtered_response = integration_client.get("/api/datasets", params={"organelle": "nucleus"})
    assert filtered_response.status_code == 200

    payload = filtered_response.json()
    assert payload["results"]
    assert all("nucleus" in item["organelles"] for item in payload["results"])
    assert all(item["included_status"] == "included" for item in payload["results"])
    assert payload["commonalities"]["top_organelles"]

    status_response = integration_client.get("/api/datasets", params={"status": "partial"})
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["results"]
    assert all(item["public_data_status"] == "partial" for item in status_payload["results"])

    year_response = integration_client.get("/api/datasets", params={"year": "2024"})
    assert year_response.status_code == 200
    year_payload = year_response.json()
    assert year_payload["results"]
    assert all(item["year"] == 2024 for item in year_payload["results"])

    facets_response = integration_client.get("/api/datasets/facets")
    assert facets_response.status_code == 200
    facets_payload = facets_response.json()
    assert facets_payload["cell_types"]
    assert facets_payload["organelles"]
    assert facets_payload["metric_families"]


def test_dataset_detail_and_similar_routes_work_with_seeded_ids(
    integration_client: TestClient,
) -> None:
    search_response = integration_client.get("/api/datasets")
    assert search_response.status_code == 200
    dataset_id = search_response.json()["results"][0]["dataset_id"]

    detail_response = integration_client.get(f"/api/datasets/{dataset_id}")
    assert detail_response.status_code == 200
    detail_payload = detail_response.json()
    assert detail_payload["dataset_id"] == dataset_id
    assert detail_payload["source_study_id"]
    assert detail_payload["publication_pmid"]
    assert detail_payload["source_publication_url"]

    similar_response = integration_client.get(f"/api/datasets/{dataset_id}/similar")
    assert similar_response.status_code == 200
    similar_payload = similar_response.json()
    assert all(item["dataset_id"] != dataset_id for item in similar_payload)


def test_compare_and_export_routes_use_seeded_dataset_records(
    integration_client: TestClient,
) -> None:
    search_response = integration_client.get("/api/datasets")
    assert search_response.status_code == 200
    result_ids = [item["dataset_id"] for item in search_response.json()["results"][:2]]

    compare_response = integration_client.post(
        "/api/datasets/compare",
        json={"dataset_ids": result_ids},
    )
    assert compare_response.status_code == 200
    compare_payload = compare_response.json()
    assert [item["dataset_id"] for item in compare_payload["datasets"]] == result_ids
    assert 0 <= compare_payload["comparability_score"] <= 100

    export_response = integration_client.get(
        "/api/datasets/export",
        params={"format": "json", "public": "true"},
    )
    assert export_response.status_code == 200
    export_payload = export_response.json()
    assert export_payload
    assert all(item["public_data_status"] != "none" for item in export_payload)
    assert any(item["publication_pmid"] for item in export_payload)


def test_analytics_routes_use_seeded_postgres_aggregates(
    integration_client: TestClient,
) -> None:
    cross_tab_response = integration_client.get(
        "/api/datasets/analytics/cross-tab",
        params={"row": "cell_type", "col": "public_data_status"},
        headers={REQUEST_ID_HEADER: "cross-tab-check"},
    )
    assert cross_tab_response.status_code == 200
    cross_tab_payload = cross_tab_response.json()
    assert cross_tab_payload["rows"]
    assert cross_tab_payload["cols"]
    assert sum(cross_tab_payload["row_totals"].values()) == 118
    assert cross_tab_response.headers["x-request-id"] == "cross-tab-check"

    frontier_response = integration_client.get(
        "/api/datasets/analytics/frontier",
        params={"public": "true"},
    )
    assert frontier_response.status_code == 200
    frontier_payload = frontier_response.json()
    assert frontier_payload
    assert all(item["res"] is not None for item in frontier_payload)
    assert all(item["ss"] is not None for item in frontier_payload)

    toolkit_response = integration_client.get(
        "/api/datasets/analytics/toolkit",
        params={"family": "EM"},
    )
    assert toolkit_response.status_code == 200
    toolkit_payload = toolkit_response.json()
    assert toolkit_payload["modalities"] == ["EM"]
    assert toolkit_payload["organelles"]

    grammar_response = integration_client.get(
        "/api/datasets/analytics/measurement-grammar",
        params={"family": "EM"},
    )
    assert grammar_response.status_code == 200
    grammar_payload = grammar_response.json()
    assert grammar_payload["organelles"]
    assert grammar_payload["metric_families"]
    assert grammar_payload["matrix"]
    assert any(grammar_payload["organelle_metric_family_counts"].values())

    reusability_response = integration_client.get(
        "/api/datasets/analytics/reusability-map",
        params={"family": "EM"},
    )
    assert reusability_response.status_code == 200
    reusability_payload = reusability_response.json()
    assert reusability_payload["statuses"] == ["complete", "partial", "none"]
    assert reusability_payload["organelles"]
    assert reusability_payload["matrix"]
    assert any(reusability_payload["row_totals"].values())

    coverage_response = integration_client.get(
        "/api/datasets/analytics/coverage-atlas",
        params={"family": "EM"},
    )
    assert coverage_response.status_code == 200
    coverage_payload = coverage_response.json()
    assert coverage_payload["cell_types"]
    assert coverage_payload["organelles"]
    assert coverage_payload["matrix"]
    assert any(coverage_payload["cell_type_totals"].values())

    timeline_response = integration_client.get(
        "/api/datasets/analytics/timeline",
        params={"family": "EM"},
    )
    assert timeline_response.status_code == 200
    timeline_payload = timeline_response.json()
    assert timeline_payload["years"]
    assert timeline_payload["modality_families"] == ["EM"]
    assert any(timeline_payload["year_totals"].values())

    benchmarks_response = integration_client.get("/api/datasets/analytics/benchmarks")
    assert benchmarks_response.status_code == 200
    benchmarks_payload = benchmarks_response.json()
    assert benchmarks_payload
    assert all(item["count"] >= 1 for item in benchmarks_payload)
    assert all("modality_family" in item for item in benchmarks_payload)

    plan_response = integration_client.get(
        "/api/datasets/analytics/plan",
        params={"organelles": "nucleus", "res": "50", "ss": "5"},
    )
    assert plan_response.status_code == 200
    plan_payload = plan_response.json()
    assert plan_payload["status"] in {"feasible", "challenging", "high-risk", "frontier"}
    assert plan_payload["biological_target"]
    assert plan_payload["matched_records_count"] >= plan_payload["threshold_records_count"]
    assert "precedents" in plan_payload

    any_threshold_response = integration_client.get(
        "/api/datasets/analytics/plan",
        params={"organelles": "nucleus,mitochondria", "metric": "volume"},
    )
    assert any_threshold_response.status_code == 200
    any_threshold_payload = any_threshold_response.json()
    assert any_threshold_payload["target_res_nm"] is None
    assert any_threshold_payload["target_sample_size"] is None
    assert any_threshold_payload["precedents"]

    plan_export_response = integration_client.get(
        "/api/datasets/analytics/plan/export",
        params={"organelles": "nucleus,mitochondria", "metric": "volume"},
    )
    assert plan_export_response.status_code == 200
    assert "PMID" in plan_export_response.text


def test_cross_tab_rejects_unsupported_dimensions(
    integration_client: TestClient,
) -> None:
    response = integration_client.get(
        "/api/datasets/analytics/cross-tab",
        params={"row": "bogus_dimension", "col": "cell_type"},
    )
    assert response.status_code == 400
    assert "Unsupported analytics dimension" in response.json()["detail"]
