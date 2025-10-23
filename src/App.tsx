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
function hasTag(c: Center, t: string) { const Sidebar = (
    <div style={{borderRight: "1px solid #e5e7eb", padding: 12, overflow: "auto"}}>
      <h1 style={{fontSize: 18, fontWeight: 600}}>서울 시험장 안내</h1>
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

      <div style={{paddingTop: 8, fontSize: 11, color: "#6b7280"}}>지도 타일: OpenStreetMap. 텍스트 라벨: MapLibre demo glyphs. 운영 전환 시 자체 타일/글리프 서버 권장.</div>
    </div>
  );

  return (
    <div style={{height: "100vh", width: "100vw", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(260px,400px) 1fr"}}>
      {/* 데스크톱 사이드바 */}
      {!isMobile && Sidebar}

      {/* 지도 */}
      <div ref={mapRef} style={{height: "100%", width: "100%", position: "relative"}} />

      {/* 모바일 토글 버튼 */}
      {isMobile && (
        <button aria-label="목록 열기" onClick={() => setPanelOpen(true)}
          style={{position: "fixed", left: 12, bottom: 12, zIndex: 20, width: 48, height: 48, borderRadius: 9999, border: "1px solid #d1d5db", background: "#fff", boxShadow: "0 4px 10px rgba(0,0,0,0.12)", fontSize: 12}}>
          목록
        </button>
      )}

      {/* 모바일 패널 */}
      {isMobile && panelOpen && (
        <div role="dialog" aria-modal="true"
             style={{position: "fixed", left: 0, right: 0, bottom: 0, height: "72vh", zIndex: 30, background: "#fff", borderTopLeftRadius: 16, borderTopRightRadius: 16, boxShadow: "0 -8px 24px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column"}}>
          <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", padding: 10, borderBottom: "1px solid #eee"}}>
            <div style={{fontWeight: 700}}>시험장 목록</div>
            <button onClick={() => setPanelOpen(false)} aria-label="닫기" style={{fontSize: 14, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff"}}>닫기</button>
          </div>
          <div style={{flex: 1, overflow: "auto", padding: 8}}>
            {Sidebar}
          </div>
        </div>
      )}
    </div>
  );
}
