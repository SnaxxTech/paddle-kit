// src/core/json.ts
function jsonValue(v) {
  if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return parsed !== null && typeof parsed === "object" ? parsed : v;
  } catch {
    return v;
  }
}

export {
  jsonValue
};
