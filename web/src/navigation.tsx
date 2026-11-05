import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

export type Route = { view: string; id?: string };
const pages = new Set([
  "fleet",
  "projects",
  "jobs",
  "activity",
  "canary",
  "access",
]);
function readRoute(): Route {
  try {
    const [page, raw, extra] = location.hash.replace(/^#\/?/, "").split("/");
    if (extra !== undefined) return { view: "fleet" };
    if (
      page === "hosts" &&
      raw &&
      /^[A-Za-z0-9_-]{1,80}$/.test(decodeURIComponent(raw))
    )
      return { view: "host", id: decodeURIComponent(raw) };
    if (
      page === "projects" &&
      raw &&
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(decodeURIComponent(raw))
    )
      return { view: "projects", id: decodeURIComponent(raw) };
    if (pages.has(page) && !raw) return { view: page };
  } catch {
    /* Invalid fragments are never used as API paths. */
  }
  return { view: "fleet" };
}
export function routeHref(route: Route) {
  if (route.view === "host" && route.id)
    return `#/hosts/${encodeURIComponent(route.id)}`;
  if (route.view === "projects" && route.id)
    return `#/projects/${encodeURIComponent(route.id)}`;
  return `#/${pages.has(route.view) ? route.view : "fleet"}`;
}
function focusHeading() {
  const frame = requestAnimationFrame(() => {
    const heading = document.querySelector<HTMLElement>("#content h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  });
  return () => cancelAnimationFrame(frame);
}
type Navigation = {
  route: Route;
  navigate: (
    route: Route,
    options?: { replace?: boolean; force?: boolean },
  ) => boolean;
  canLeave: () => boolean;
  register: (guard: () => string | null) => () => void;
};
const Context = createContext<Navigation | null>(null);
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState(readRoute);
  const current = useRef(route);
  const guards = useRef(new Set<() => string | null>());
  const register = useCallback((guard: () => string | null) => {
    guards.current.add(guard);
    return () => {
      guards.current.delete(guard);
    };
  }, []);
  const canLeave = useCallback(() => {
    const labels = [...guards.current].map((guard) => guard()).filter(Boolean);
    return (
      !labels.length ||
      window.confirm(
        `Leave without saving changes to ${labels.join(" and ")}? Unsaved input will be discarded.`,
      )
    );
  }, []);
  const navigate = useCallback(
    (next: Route, options: { replace?: boolean; force?: boolean } = {}) => {
      if (routeHref(next) === routeHref(current.current)) {
        focusHeading();
        return true;
      }
      if (!options.force && !canLeave()) return false;
      history[options.replace ? "replaceState" : "pushState"](
        null,
        "",
        routeHref(next),
      );
      current.current = next;
      setRoute(next);
      return true;
    },
    [canLeave],
  );
  useEffect(() => {
    if (location.hash !== routeHref(current.current))
      history.replaceState(null, "", routeHref(current.current));
    const changed = () => {
      const next = readRoute();
      if (routeHref(next) === routeHref(current.current)) {
        if (location.hash !== routeHref(next))
          history.replaceState(null, "", routeHref(next));
        return;
      }
      if (!canLeave()) {
        history.pushState(null, "", routeHref(current.current));
        return;
      }
      current.current = next;
      if (location.hash !== routeHref(next))
        history.replaceState(null, "", routeHref(next));
      setRoute(next);
    };
    const unloading = (event: BeforeUnloadEvent) => {
      if ([...guards.current].some((guard) => guard())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("popstate", changed);
    window.addEventListener("hashchange", changed);
    window.addEventListener("beforeunload", unloading);
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("beforeunload", unloading);
    };
  }, [canLeave]);
  useEffect(focusHeading, [route.view, route.id]);
  return (
    <Context.Provider value={{ route, navigate, canLeave, register }}>
      {children}
    </Context.Provider>
  );
}
export function useNavigation() {
  const navigation = useContext(Context);
  if (!navigation) throw new Error("Navigation context is required");
  return navigation;
}
/** Keep drafts in memory only; secrets never enter browser storage or URLs. */
export function useUnsavedChanges(dirty: boolean, label: string) {
  const { register } = useNavigation();
  const value = useRef<string | null>(null);
  value.current = dirty ? label : null;
  useEffect(() => register(() => value.current), [register]);
  return () => {
    value.current = null;
  };
}
export function RouteLink({
  to,
  afterNavigate,
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "onClick"> & {
  to: Route;
  afterNavigate?: () => void;
}) {
  const { navigate } = useNavigation();
  return (
    <a
      {...props}
      href={routeHref(to)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        if (navigate(to)) afterNavigate?.();
      }}
    >
      {children}
    </a>
  );
}
