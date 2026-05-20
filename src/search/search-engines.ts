// 지원 검색 엔진별 SERP URL 빌더.
// 오케스트레이터가 search/paginate 액션에서 사용한다.
//
// 페이지네이션 규약: 사용자 입장의 1-based 페이지 번호를 받아 엔진별 offset 파라미터로 변환.
//   google: start = (page-1) * 10
//   bing:   first = (page-1) * 10 + 1
//   naver:  start = (page-1) * 10 + 1

export type SearchEngine = "google" | "bing" | "naver";

export const SUPPORTED_ENGINES: readonly SearchEngine[] = ["google", "bing", "naver"];

export function isSupportedEngine(value: string): value is SearchEngine {
  return (SUPPORTED_ENGINES as readonly string[]).includes(value);
}

// 엔진/쿼리/페이지 조합으로 SERP URL 생성.
// page는 1-based. page <= 0 입력 시 1로 정규화.
export function buildSerpUrl(engine: SearchEngine, query: string, page: number): string {
  const safePage = Math.max(1, Math.floor(page));
  const q = encodeURIComponent(query);
  switch (engine) {
    case "google": {
      const start = (safePage - 1) * 10;
      const startParam = start > 0 ? `&start=${start}` : "";
      return `https://www.google.com/search?q=${q}&hl=en&gl=us${startParam}`;
    }
    case "bing": {
      const first = (safePage - 1) * 10 + 1;
      return `https://www.bing.com/search?q=${q}&first=${first}`;
    }
    case "naver": {
      const start = (safePage - 1) * 10 + 1;
      return `https://search.naver.com/search.naver?query=${q}&start=${start}`;
    }
  }
}
