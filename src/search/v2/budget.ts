// 트리 전체가 공유하는 비용·중복 한도 관리.
// 모든 리서처가 동일 인스턴스를 참조하며, 행동 직전에 reserve* / can* 메서드로 한도를 체크한다.
// 한도 검사가 통과하면 카운터를 증가시키고 진행; 실패하면 호출부가 거부 경로로 보낸다.
import type { SearchEngine } from "../search-engines.js";
import type { BudgetLimits } from "./types.js";

const DEFAULT_LIMITS: BudgetLimits = {
  maxRounds: 20,
  maxSearches: 8,
  maxExplores: 10,
  maxParallel: 3,
  maxDepth: 3,
  maxChildCallsPerAgent: 3,
};

interface SearchEntry {
  engine: SearchEngine;
  query: string;
  page: number;
}

export class SharedBudget {
  readonly limits: BudgetLimits;
  readonly visitedUrls: Set<string> = new Set();
  readonly searchHistory: SearchEntry[] = [];

  roundsUsed = 0;
  searchesUsed = 0;
  exploresUsed = 0;

  constructor(overrides?: Partial<BudgetLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...overrides };
  }

  // 라운드 카운트는 모든 리서처가 호출 직전에 1씩 증가시킨다.
  // 호출부에서 직접 증가시키므로 메서드는 단순 체크만.
  roundsRemaining(): number {
    return Math.max(0, this.limits.maxRounds - this.roundsUsed);
  }
  consumeRound(): void {
    this.roundsUsed++;
  }

  // 검색 한도 체크. (engine, query, page) 삼중쌍 중복도 함께 거부.
  // 사용 가능하면 true 반환 + history 등록 + 카운터 증가.
  reserveSearch(engine: SearchEngine, query: string, page: number): { ok: true } | { ok: false; reason: string } {
    if (this.searchesUsed >= this.limits.maxSearches) {
      return { ok: false, reason: `search/paginate 한도(${this.limits.maxSearches})에 도달했습니다.` };
    }
    if (this.searchHistory.some((h) => h.engine === engine && h.query === query && h.page === page)) {
      return { ok: false, reason: `이미 ${engine}/"${query}" ${page}페이지를 시도했습니다.` };
    }
    this.searchHistory.push({ engine, query, page });
    this.searchesUsed++;
    return { ok: true };
  }

  // 하위 리서처 호출 한도 체크. URL이 있으면 중복도 트리 전체에서 거부.
  // URL 없는 delegate도 비용을 쓰는 하위 호출이므로 exploresUsed를 증가시킨다.
  reserveDelegate(url?: string): { ok: true } | { ok: false; reason: string } {
    if (this.exploresUsed >= this.limits.maxExplores) {
      return { ok: false, reason: `리서처 위임 한도(${this.limits.maxExplores})에 도달했습니다.` };
    }
    if (url && this.visitedUrls.has(url)) {
      return { ok: false, reason: `${url}은 이 세션에서 이미 방문했습니다.` };
    }
    if (url) this.visitedUrls.add(url);
    this.exploresUsed++;
    return { ok: true };
  }

  reserveExplore(url: string): { ok: true } | { ok: false; reason: string } {
    return this.reserveDelegate(url);
  }

  // 깊이 한도 — 자식을 호출할 수 있는지.
  canRecurseDeeper(currentDepth: number): boolean {
    return currentDepth + 1 <= this.limits.maxDepth;
  }

  // 현재 남은 병렬 슬롯 (남은 explore 예산과 maxParallel 중 작은 값).
  parallelSlotsRemaining(): number {
    return Math.min(this.limits.maxParallel, this.limits.maxExplores - this.exploresUsed);
  }

  // 디버그 / 메시지 주입용 요약.
  summary(): string {
    return `라운드 ${this.roundsUsed}/${this.limits.maxRounds}, 검색 ${this.searchesUsed}/${this.limits.maxSearches}, 위임 ${this.exploresUsed}/${this.limits.maxExplores}`;
  }
}
