import { useCallback, useEffect, useState } from "react";

// The open Session lives in the URL so refresh, back and shared links keep it.
export function useSearchParam(name: string) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const read = () => setValue(new URL(location.href).searchParams.get(name) ?? "");
    read();
    addEventListener("popstate", read);
    return () => removeEventListener("popstate", read);
  }, [name]);
  const update = useCallback(
    (next: string, mode: "push" | "replace" = "push") => {
      const url = new URL(location.href);
      if (next) url.searchParams.set(name, next);
      else url.searchParams.delete(name);
      history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
      setValue(next);
    },
    [name],
  );
  return [value, update] as const;
}
