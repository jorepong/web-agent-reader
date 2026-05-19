// LLM 응답에서 JSON을 관대하게 파싱.
// 모델이 ```json 코드 펜스로 감싸거나 JSON 앞뒤에 설명 문장을 덧붙이는 경우를 흡수한다.
// 1차: 코드 펜스만 벗긴 뒤 JSON.parse 시도.
// 2차: 첫 번째 균형 잡힌 { ... } 블록을 추출해 재시도.
// 모두 실패하면 null 반환 — 호출부가 fallback 처리.
export function parseJsonResponse<T = unknown>(text: string): T | null {
  const stripped = stripCodeFence(text.trim());
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // fallthrough to extraction
  }
  const obj = extractFirstBalancedObject(stripped);
  if (obj === null) return null;
  try {
    return JSON.parse(obj) as T;
  } catch {
    return null;
  }
}

function stripCodeFence(s: string): string {
  const match = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1]! : s;
}

// 첫 번째 균형 잡힌 { ... } 블록을 추출. 문자열 리터럴 안의 중괄호는 무시.
function extractFirstBalancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.substring(start, i + 1);
    }
  }
  return null;
}
