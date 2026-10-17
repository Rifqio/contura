export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `q${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
