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
  // 파일 상단 컴포넌트 내부에 추가
const [sidebarOpen, setSidebarOpen] = useState(true);

// 사이드바 토글 시 지도 리사이즈
useEffect(() => {
  // 사이드바 애니메이션이 끝난 뒤 리사이즈(미세 딜레이)
  const t = setTimeout(() => mapObj.current?.resize(), 220);
  return () => clearTimeout(t);
}, [sidebarOpen]);


  // 관리자 모드 게이트: ?admin=SECRET 이 VITE_ADMIN_SECRET와 일치할 때만 업로드 UI 노출
  const admin = useMemo(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("admin") || "";
      // @ts-ignore
      const secret = (import.meta && import.meta.env && import.meta.env.VITE_ADMIN_SECRET) || "";
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

  // 비관리자: 공개 JSON 자동 로드(있을 때만) + 실패 시 CSV 런타임 파싱 폴백
  useEffect(() => {
    if (admin) return;
    (async () => {
      try {
        const basePath = ((import.meta as any)?.env?.BASE_URL || (window as any).BASE_URL || "/") as string;
      const absBase = new URL(basePath, window.location.origin).toString();
        // 1차: centers.json 시도
        const jsonUrl = new URL("centers.json", absBase).toString();
        const res = await fetch(jsonUrl, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            validateCenters(data as Center[], undefined);
            setCenters(data as Center[]);
            return;
          }
        }
        // 2차: data/centers.csv 런타임 파싱
        const csvUrl = new URL("data/centers.csv", absBase).toString();
        const csvRes = await fetch(csvUrl, { cache: "no-store" });
        if (csvRes.ok) {
          const text = await csvRes.text();
          const parsed = parseCSV(text);
          if (parsed.length > 0) {
            validateCenters(parsed, undefined);
            setCenters(parsed);
            console.warn("[fallback] loaded data from data/centers.csv at runtime");
          }
        } else {
          console.warn("centers.json and data/centers.csv not found. showing empty map.");
        }
      } catch (e) { console.error(e); }
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
      map.addLayer({ id: "labels", type: "symbol", source: "centers", filter: ["!has", "point_count"], layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 14, "text-offset": [0, 1.2], "text-anchor": "top" }, paint: { "text-halo-color": "#ffffff", "text-halo-width": 1 } });

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
    <div
  id="layout"
  style={{
    position: "relative",
    height: "100vh",
    width: "100vw",
    display: "grid",
    gridTemplateColumns: sidebarOpen ? "minmax(260px,400px) 1fr" : "0px 1fr",
    transition: "grid-template-columns .2s ease"
  }}
>

      <aside
  style={{
    borderRight: "1px solid #e5e7eb",
    padding: sidebarOpen ? 12 : 0,
    overflow: "auto",
    overflowY: "auto",
    transition: "padding .2s ease",
  }}
  aria-hidden={!sidebarOpen}
>
        <h1 style={{fontSize: 18, fontWeight: 600}}>HRDK 서울강남지사 시험장 안내</h1>
        <p style={{fontSize: 13, color: "#666"}}>표시 영역 제한: 강남·서초·송파·강동만.</p>
        {admin && (<div style={{display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 8px", borderRadius: 9999, background: "#fef3c7", color: "#92400e"}}>관리자 모드</div>)}

        {/* 태그 필터 */}
        <div style={{marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12}}>
          <div style={{fontSize: 14, fontWeight: 600}}>태그 필터</div>
          {allTags.length === 0 ? (
            <div style={{fontSize: 12, color: "#6b7280"}}>사용 가능한 태그가 없습니다.</div>
          ) : (
            <div style={{display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6}}>
              {allTags.map((t) => (
                <button key={t} onClick={() => toggleTag(t)}
                  style={{fontSize: 12, padding: "4px 8px", borderRadius: 9999, border: "1px solid #d1d5db", background: activeTags.includes(t) ? "#2563eb" : "#fff", color: activeTags.includes(t) ? "#fff" : "#374151"}}>
                  {t}
                </button>
              ))}
              {activeTags.length > 0 && (
                <button onClick={clearTags} style={{fontSize: 12, textDecoration: "underline"}}>초기화</button>
              )}
            </div>
          )}
          <div style={{fontSize: 11, color: "#6b7280", marginTop: 6}}>필기: 파란색, 실기(작업): 빨간색, 기타: 초록색</div>
        </div>

        {/* CSV 업로드 (관리자 전용) */}
        {admin && (
          <div style={{marginTop: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f9fafb"}}>
            <div style={{fontSize: 14, fontWeight: 600}}>CSV 업로드</div>
            <input type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadCSV(f); }} />
            <div style={{fontSize: 12, color: "#6b7280"}}>필수 헤더: id,name,lat,lng | 선택: address,phone,hours,note,tags</div>
            {csvError && <div style={{fontSize: 12, color: "#dc2626"}}>{csvError}</div>}
            <details>
              <summary style={{fontSize: 12, textDecoration: "underline", cursor: "pointer"}}>CSV 텍스트로 붙여넣기</summary>
              <div style={{marginTop: 8}}>
                <textarea onChange={(e) => onPasteCSV(e.target.value)} placeholder="id,name,address,lat,lng,phone,hours,note,tags ..." style={{width: "100%", height: 120, border: "1px solid #d1d5db", borderRadius: 8, padding: 8, fontSize: 13}} />
              </div>
            </details>
          </div>
        )}

        {/* 검색 */}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름, 주소, 메모, 태그 검색"
               style={{width: "100%", border: "1px solid #d1d5db", borderRadius: 16, padding: "6px 10px", fontSize: 13, marginTop: 12}} />
        <div style={{fontSize: 12, color: "#6b7280"}}>총 {filtered.length}개 표시{centers.length===0?" (데이터 없음)":""}</div>

        
        {/* 목록 */}
        <ul style={{marginTop: 8, display: "flex", flexDirection: "column", gap: 8, overflow: "auto", maxHeight: "calc(100vh - 340px)", paddingRight: 4}}>
          {filtered.map((c) => (
            <li key={c.id} style={{border: "1px solid #e5e7eb", borderRadius: 12, padding: 12}}>
              <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
                <div style={{fontWeight: 600, fontSize: 14}}>{c.name}</div>
                <button onClick={() => flyToCenter(c.lng, c.lat)} style={{fontSize: 12, textDecoration: "underline", opacity: 0.8}}>지도이동</button>
              </div>
              <div style={{fontSize: 12, color: "#4b5563", marginTop: 4}}>{c.address}</div>
              <div style={{fontSize: 11, color: "#6b7280", marginTop: 4}}>{c.note}</div>
              <div style={{marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4}}>{(c.tags || []).map((tag) => (
                <span key={tag} style={{fontSize: 10, background: "#eff6ff", color: "#1d4ed8", padding: "2px 8px", borderRadius: 9999}}>{tag}</span>
              ))}</div>
            </li>
          ))}
          {filtered.length === 0 && (<li style={{fontSize: 12, color: "#6b7280"}}>표시할 데이터가 없습니다.</li>)}
        </ul>

        <div style={{paddingTop: 8, fontSize: 11, color: "#6b7280"}}>지도 타일: OpenStreetMap. 텍스트 라벨: MapLibre demo glyphs. 운영 전환 시 자체 타일/글리프 서버 권장.
        <br />
        한국산업인력공단 서울강남지사 자격시험부 작성 2025-10-24</div>
      </aside>
      
      {/* layout 안, aside와 map div 사이 어딘가에 추가 */}
<button
  onClick={() => setSidebarOpen(v => !v)}
  aria-pressed={sidebarOpen}
  aria-label={sidebarOpen ? "사이드바 닫기" : "사이드바 열기"}
  style={{
    position: "absolute",
    top: 10,
    left: sidebarOpen ? 340 : 10, // 열렸을 때는 사이드바 경계 근처
    zIndex: 5,
    border: 0,
    borderRadius: 9999,
    padding: "8px 10px",
    background: "#111",
    color: "#fff",
    fontSize: 14,
    lineHeight: 1,
    boxShadow: "0 6px 18px rgba(0,0,0,.2)",
    cursor: "pointer",
    transition: "left .2s ease"
  }}
>
  {sidebarOpen ? "◀︎" : "▶︎"}
</button>

      <div ref={mapRef} style={{height: "100%", width: "100%"}} />
    </div>
  );
}
