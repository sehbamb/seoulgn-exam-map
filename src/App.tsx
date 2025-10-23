import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map as MlMap, LngLatBoundsLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// =========================
// 데이터 스키마 정의
// =========================
export type Center = {
  id: string;
  name: string;
  address?: string;
  lat: number;
  lng: number;
  phone?: string;
  hours?: string;
  note?: string;
  tags?: string[];
};

// 초기값: CSV/centers.json 로드 전 기본 값
const INITIAL_CENTERS: Center[] = [];

// =========================
// 유틸: 테스트/가드
// =========================
function assert(condition: boolean, message: string) {
  if (!condition) throw new Error("Test failed: " + message);
}

function validateCenters(data: Center[], bounds?: LngLatBoundsLike) {
  data.forEach((c) => {
    assert(typeof c.id === "string" && c.id.length > 0, `invalid id for ${c.name}`);
    assert(typeof c.name === "string" && c.name.length > 0, `invalid name for ${c.id}`);
    assert(typeof c.lat === "number" && !Number.isNaN(c.lat), `lat must be number: ${c.id}`);
    assert(typeof c.lng === "number" && !Number.isNaN(c.lng), `lng must be number: ${c.id}`);
    if (bounds) {
      const [[w, s], [e, n]] = bounds as any;
      assert(c.lat >= s && c.lat <= n, `lat out of bounds: ${c.id}`);
      assert(c.lng >= w && c.lng <= e, `lng out of bounds: ${c.id}`);
    }
  });
}

function runSmokeTests(map: MlMap) {
  const style = map.getStyle();
  assert(!!(style as any).glyphs, 'style.glyphs missing (required for "text-field")');
  ["clusters", "cluster-count", "unclustered", "labels", "outside-mask", "region-outline"].forEach((id) => {
    assert(!!map.getLayer(id), `layer not found: ${id}`);
  });
}

// CSV 파서: 헤더 기반. tags는 ; 또는 , 구분 허용
function parseCSV(text: string): Center[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (k: string) => header.findIndex((h) => h.toLowerCase() === k);
  const idI = idx("id"), nameI = idx("name"), addrI = idx("address"), latI = idx("lat"), lngI = idx("lng"), phoneI = idx("phone"), hoursI = idx("hours"), noteI = idx("note"), tagsI = idx("tags");
  assert(idI >= 0 && nameI >= 0 && latI >= 0 && lngI >= 0, "CSV header must include id,name,lat,lng");
  const rows = lines.slice(1);
  const out: Center[] = [];
  for (const row of rows) {
    const cells = row.split(",");
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const get = (i: number) => (i >= 0 ? cells[i]?.trim() ?? "" : "");
    const lat = Number(get(latI));
    const lng = Number(get(lngI));
    const tagsRaw = get(tagsI);
    const tags = tagsRaw ? tagsRaw.split(/[;|,]/).map((t) => t.trim()).filter(Boolean) : [];
    out.push({ id: get(idI), name: get(nameI), address: get(addrI), lat, lng, phone: get(phoneI), hours: get(hoursI), note: get(noteI), tags });
  }
  return out;
}

// 지도 보조 유틸
function hasTag(c: Center, t: string) { return (c.tags || []).some((x) => x.trim() === t); }
function fitToData(map: MlMap, coords: [number, number][]) {
  if (!coords || coords.length === 0) return;
  const b = new maplibregl.LngLatBounds();
  coords.forEach((c) => b.extend(c as any));
  map.fitBounds(b as LngLatBoundsLike, { padding: 40, duration: 600 });
}
function buildOutsideMask(bounds: [[number, number], [number, number]]) {
  const [[west, south], [east, north]] = bounds;
  const world = [ [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85] ];
  const region = [ [west, south], [east, south], [east, north], [west, north], [west, south] ];
  return { type: "FeatureCollection", features: [
    { type: "Feature", properties: { role: "mask" }, geometry: { type: "Polygon", coordinates: [world, region] as any } },
    { type: "Feature", properties: { role: "region" }, geometry: { type: "Polygon", coordinates: [region] as any } }
  ] } as const;
}

export default function SeoulExamCentersMap() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapObj = useRef<MlMap | null>(null);

  const [query, setQuery] = useState("");
  const [centers, setCenters] = useState<Center[]>(INITIAL_CENTERS);
  const [csvError, setCsvError] = useState<string | null>(null);

  // 관리자 모드 게이트: ?admin=SECRET 이 VITE_ADMIN_SECRET와 일치할 때만 업로드 UI 노출
  const admin = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("admin") || "";
      // @ts-ignore
      const secret = "2161";
      return Boolean(secret) && fromUrl === String(secret);
    } catch { return false; }
  }, []);

  // 강남·서초·송파·강동 경계 근사 BBox 고정
  const TARGET_BOUNDS: LngLatBoundsLike = useMemo(() => [[126.96, 37.43], [127.18, 37.59]], []);

  // 태그 목록, 필터 상태
  const allTags = useMemo(() => {
    const s = new Set<string>();
    centers.forEach((c) => (c.tags || []).forEach((t) => s.add(t.trim())));
    return Array.from(s).sort();
  }, [centers]);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const toggleTag = (t: string) => setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  const clearTags = () => setActiveTags([]);

  // 검색 + 태그 필터
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let arr = centers;
    if (q) arr = arr.filter((c) => [c.name, c.address, c.note, ...(c.tags || [])].join(" ").toLowerCase().includes(q));
    if (activeTags.length > 0) arr = arr.filter((c) => (c.tags || []).some((t) => activeTags.includes(t)));
    return arr;
  }, [centers, query, activeTags]);

  // GeoJSON: examType 파생. 실기(작업) 빨강, 필기 파랑, 나머지 초록
  const geojson = useMemo(() => ({
    type: "FeatureCollection",
    features: filtered.map((c) => {
      const examType = hasTag(c, "실기(작업)") ? "실기(작업)" : hasTag(c, "필기") ? "필기" : "기타";
      return {
        type: "Feature",
        properties: {
          id: c.id, name: c.name, address: c.address, phone: c.phone, hours: c.hours, note: c.note,
          tags: (c.tags || []).join(", "), examType
        },
        geometry: { type: "Point", coordinates: [c.lng, c.lat] }
      } as const;
    })
  }), [filtered]);

  // CSV 업로드/붙여넣기(관리자)
  const onUploadCSV = async (file: File) => {
    setCsvError(null);
    try { const text = await file.text(); const parsed = parseCSV(text); validateCenters(parsed, TARGET_BOUNDS); setCenters(parsed); }
    catch (e: any) { setCsvError(e?.message || String(e)); }
  };
  const onPasteCSV = (text: string) => {
    setCsvError(null);
    try { const parsed = parseCSV(text); validateCenters(parsed, TARGET_BOUNDS); setCenters(parsed); }
    catch (e: any) { setCsvError(e?.message || String(e)); }
  };

  // 비관리자: 공개 JSON 자동 로드(있을 때만)
  useEffect(() => {
    if (admin) return;
    (async () => {
      try {
        const res = await fetch(new URL("centers.json", (import.meta as any)?.env?.BASE_URL || (window as any).BASE_URL || "/").toString(), { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) { validateCenters(data as Center[], undefined); setCenters(data as Center[]); }
        }
      } catch { /* 공개 데이터 없으면 무시 */ }
    })();
  }, [admin]);

  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap" } },
        layers: [{ id: "osm", type: "raster", source: "osm" }]
      },
      center: [127.06, 37.51], zoom: 11, dragRotate: false
    });

    // 관할 경계 고정 + 마스킹
    map.setMaxBounds(TARGET_BOUNDS);
    map.fitBounds(TARGET_BOUNDS, { padding: 20, duration: 0 });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    mapObj.current = map;

    map.on("load", () => {
      const mask = buildOutsideMask(TARGET_BOUNDS as any);
      map.addSource("mask", { type: "geojson", data: mask as any });
      map.addLayer({ id: "outside-mask", type: "fill", source: "mask", paint: { "fill-color": "#000", "fill-opacity": 0.25 } });
      map.addLayer({ id: "region-outline", type: "line", source: "mask", filter: ["==", ["get", "role"], "region"], paint: { "line-color": "#2d6de9", "line-width": 2 } });

      // 클러스터 소스/레이어
      map.addSource("centers", { type: "geojson", data: geojson as any, cluster: true, clusterRadius: 50, clusterMaxZoom: 14 });
      map.addLayer({ id: "clusters", type: "circle", source: "centers", filter: ["has", "point_count"], paint: {
        "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 30, 26, 100, 32],
        "circle-color": ["step", ["get", "point_count"], "#88b9f3", 10, "#5e97ef", 30, "#2d6de9"], "circle-opacity": 0.9 } });
      map.addLayer({ id: "cluster-count", type: "symbol", source: "centers", filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count"], "text-font": ["Noto Sans Regular"], "text-size": 12 }, paint: { "text-color": "#fff" } });

      // 단일 포인트: 태그 색상
      map.addLayer({ id: "unclustered", type: "circle", source: "centers", filter: ["!has", "point_count"], paint: {
        "circle-radius": 8,
        "circle-color": ["match", ["get", "examType"], "필기", "#1e88e5", "실기(작업)", "#e53935", "#2bb673"],
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });

      // 라벨
      map.addLayer({ id: "labels", type: "symbol", source: "centers", filter: ["!has", "point_count"], layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-halo-color": "#ffffff", "text-halo-width": 1 } });

      // 상호작용
      map.on("click", "clusters", (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const clusterId = features[0].properties?.cluster_id as number;
        const source = map.getSource("centers") as maplibregl.GeoJSONSource;
        source.getClusterExpansionZoom(clusterId, (err, zoom) => { if (err) return; map.easeTo({ center: (features[0].geometry as any).coordinates, zoom }); });
      });
      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, anchor: "bottom" });
      map.on("click", "unclustered", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["unclustered"] })[0]; if (!f) return;
        const p = f.properties as any; const coords = (f.geometry as any).coordinates.slice();
        const html = `<div style="font-family:system-ui;min-width:220px"><div style="font-weight:700;margin-bottom:6px">${p.name}</div><div style="font-size:12px;color:#444">${p.address || ""}</div>${p.phone ? `<div style=\"font-size:12px;color:#444\">☎ ${p.phone}</div>` : ""}${p.hours ? `<div style=\"font-size:12px;color:#444\">⏰ ${p.hours}</div>` : ""}${p.note ? `<div style=\"font-size:12px;color:#444\">📝 ${p.note}</div>` : ""}${p.tags ? `<div style=\"margin-top:6px;font-size:11px;color:#2d6de9\">${p.tags}</div>` : ""}</div>`;
        popup.setLngLat(coords).setHTML(html).addTo(map);
      });
      map.on("mouseenter", "unclustered", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "unclustered", () => (map.getCanvas().style.cursor = ""));

      // 초기 범위: 데이터 있으면 데이터로, 없으면 관할 경계
      if (geojson.features.length > 0) {
        fitToData(map, geojson.features.map((f) => f.geometry.coordinates as [number, number]));
      } else { map.fitBounds(TARGET_BOUNDS, { padding: 20, duration: 0 }); }

      // 스모크 테스트
      try { runSmokeTests(map); } catch (e) { console.error(e); }
    });

    return () => map.remove();
  }, [TARGET_BOUNDS]);

  // 데이터 변경 시 소스 갱신 및 뷰 맞춤
  useEffect(() => {
    const map = mapObj.current; if (!map) return;
    const src = map.getSource("centers") as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(geojson as any); if (geojson.features.length > 0) { fitToData(map, geojson.features.map((f) => f.geometry.coordinates as [number, number])); } }
  }, [geojson]);

  const flyToCenter = (lng: number, lat: number) => {
    const map = mapObj.current; if (!map) return;
    const target = new maplibregl.LngLatBounds(TARGET_BOUNDS as any);
    const clampedLng = Math.max(target.getWest(), Math.min(lng, target.getEast()));
    const clampedLat = Math.max(target.getSouth(), Math.min(lat, target.getNorth()));
    map.easeTo({ center: [clampedLng, clampedLat], zoom: 15 });
  };

  // UI
  return (
    <div className="w-full h-screen grid grid-cols-1 lg:grid-cols-[400px_1fr]">
      <aside className="border-r border-gray-200 p-4 space-y-3">
        <h1 className="text-xl font-semibold">서울 시험장 안내</h1>
        <p className="text-sm text-gray-600">표시 영역 제한: 강남·서초·송파·강동만.</p>
        {admin && (<div className="inline-flex items-center gap-2 text-[11px] px-2 py-[3px] rounded-full bg-amber-100 text-amber-800">관리자 모드</div>)}

        {/* 태그 필터 */}
        <div className="space-y-2 p-3 border rounded-xl">
          <div className="text-sm font-medium">태그 필터</div>
          {allTags.length === 0 ? (<div className="text-xs text-gray-500">사용 가능한 태그가 없습니다.</div>) : (
            <div className="flex flex-wrap gap-2">
              {allTags.map((t) => (
                <button key={t} onClick={() => toggleTag(t)} className={`text-xs px-2 py-[3px] rounded-full border ${activeTags.includes(t) ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700"}`} title={t}>{t}</button>
              ))}
              {activeTags.length > 0 && (<button onClick={clearTags} className="text-xs underline">초기화</button>)}
            </div>
          )}
          <div className="text-[11px] text-gray-500">필기: 파란색, 실기(작업): 빨간색, 기타: 초록색</div>
        </div>

        {/* CSV 업로드 (관리자 전용) */}
        {admin && (
          <div className="space-y-2 p-3 border rounded-xl bg-gray-50">
            <div className="text-sm font-medium">CSV 업로드</div>
            <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadCSV(f); }} />
            <div className="text-xs text-gray-500">필수 헤더: id,name,lat,lng | 선택: address,phone,hours,note,tags</div>
            {csvError && <div className="text-xs text-red-600">{csvError}</div>}
            <details>
              <summary className="text-xs underline cursor-pointer">CSV 텍스트로 붙여넣기</summary>
              <div className="space-y-2 mt-2">
                <textarea onChange={(e) => onPasteCSV(e.target.value)} placeholder="id,name,address,lat,lng,phone,hours,note,tags ..." className="w-full h-28 border rounded p-2 text-sm" />
              </div>
            </details>
          </div>
        )}

        {/* 검색 */}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름, 주소, 메모, 태그 검색" className="w-full rounded-2xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <div className="text-xs text-gray-500">총 {filtered.length}개 표시</div>

        {/* 목록 */}
        <ul className="space-y-2 overflow-auto max-h-[calc(100vh-340px)] pr-1">
          {filtered.map((c) => (
            <li key={c.id} className="group border rounded-xl p-3 hover:shadow-sm transition">
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">{c.name}</div>
                <button onClick={() => flyToCenter(c.lng, c.lat)} className="text-xs underline opacity-70 group-hover:opacity-100">지도이동</button>
              </div>
              <div className="text-xs text-gray-600 mt-1">{c.address}</div>
              <div className="text-[11px] text-gray-500 mt-1">{c.note}</div>
              <div className="mt-1 flex flex-wrap gap-1">{(c.tags || []).map((tag) => (<span key={tag} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-[2px] rounded-full">{tag}</span>))}</div>
            </li>
          ))}
          {filtered.length === 0 && (<li className="text-xs text-gray-500">표시할 데이터가 없습니다.</li>)}
        </ul>

        <div className="pt-2 text:[11px] text-gray-500">지도 타일: OpenStreetMap. 텍스트 라벨: MapLibre demo glyphs. 운영 전환 시 자체 타일/글리프 서버 권장.</div>
      </aside>

      <div ref={mapRef} className="w-full h-full" />
    </div>
  );
}
