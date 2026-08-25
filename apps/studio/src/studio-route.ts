export type StudioRoute = "m0" | "m1" | "m2" | "m1-prototype";

export const resolveStudioRoute = (search: string): StudioRoute => {
  const params = new URLSearchParams(search);
  if (params.get("prototype") === "m1") return "m1-prototype";
  if (params.get("studio") === "m0") return "m0";
  return params.get("studio") === "m2" ? "m2" : "m1";
};
