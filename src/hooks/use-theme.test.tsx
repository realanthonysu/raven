import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./use-theme";

// ─── Mocks ──────────────────────────────────────────────────────────

const STORAGE_KEY = "raven_theme";

let mockDarkMode = false;
const mockChangeListeners: Array<() => void> = [];

const mockMediaQuery = {
  get matches() {
    return mockDarkMode;
  },
  addEventListener: vi.fn((_event: string, handler: () => void) => {
    mockChangeListeners.push(handler);
  }),
  removeEventListener: vi.fn((_event: string, handler: () => void) => {
    const idx = mockChangeListeners.indexOf(handler);
    if (idx !== -1) mockChangeListeners.splice(idx, 1);
  }),
};

// ─── Helpers ────────────────────────────────────────────────────────

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function simulateSystemThemeChange(isDark: boolean) {
  mockDarkMode = isDark;
  for (const handler of [...mockChangeListeners]) {
    handler();
  }
}

// ─── Setup / Teardown ───────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  mockDarkMode = false;
  mockChangeListeners.length = 0;
  mockMediaQuery.addEventListener.mockClear();
  mockMediaQuery.removeEventListener.mockClear();

  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mockMediaQuery));
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up .dark class on <html>
  document.documentElement.classList.remove("dark");
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("useTheme", () => {
  it("throws when used outside ThemeProvider", () => {
    expect(() => renderHook(() => useTheme())).toThrow(
      "useTheme must be used within ThemeProvider",
    );
  });

  describe("default theme", () => {
    it("defaults to 'system' when no localStorage value exists", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.theme).toBe("system");
    });

    it("resolves system theme to light when OS prefers light", () => {
      mockDarkMode = false;
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.resolvedTheme).toBe("light");
    });

    it("resolves system theme to dark when OS prefers dark", () => {
      mockDarkMode = true;
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.resolvedTheme).toBe("dark");
    });
  });

  describe("reads theme from localStorage on init", () => {
    it("reads 'light' from localStorage", () => {
      localStorage.setItem(STORAGE_KEY, "light");
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.theme).toBe("light");
      expect(result.current.resolvedTheme).toBe("light");
    });

    it("reads 'dark' from localStorage", () => {
      localStorage.setItem(STORAGE_KEY, "dark");
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.theme).toBe("dark");
      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("reads 'system' from localStorage and resolves based on OS preference", () => {
      localStorage.setItem(STORAGE_KEY, "system");
      mockDarkMode = true;
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.theme).toBe("system");
      expect(result.current.resolvedTheme).toBe("dark");
    });
  });

  describe("setTheme", () => {
    it("saves the chosen theme to localStorage", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
    });

    it("updates theme state when setTheme is called", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("light");
      });

      expect(result.current.theme).toBe("light");
      expect(result.current.resolvedTheme).toBe("light");
    });

    it("can switch back to system theme", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });
      expect(result.current.theme).toBe("dark");

      act(() => {
        result.current.setTheme("system");
      });
      expect(result.current.theme).toBe("system");
      expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
    });

    it("persists across multiple setTheme calls", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });
      act(() => {
        result.current.setTheme("light");
      });
      act(() => {
        result.current.setTheme("system");
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
    });
  });

  describe("resolved theme", () => {
    it("resolves to 'light' when theme is 'light'", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("light");
      });

      expect(result.current.resolvedTheme).toBe("light");
    });

    it("resolves to 'dark' when theme is 'dark'", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("resolves 'system' based on OS preference (light)", () => {
      mockDarkMode = false;
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.resolvedTheme).toBe("light");
    });

    it("resolves 'system' based on OS preference (dark)", () => {
      mockDarkMode = true;
      const { result } = renderHook(() => useTheme(), { wrapper });

      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("updates resolved theme when system preference changes in system mode", () => {
      mockDarkMode = false;
      const { result } = renderHook(() => useTheme(), { wrapper });
      expect(result.current.resolvedTheme).toBe("light");

      act(() => {
        simulateSystemThemeChange(true);
      });

      expect(result.current.resolvedTheme).toBe("dark");
    });

    it("does not react to system preference changes when theme is not 'system'", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("light");
      });
      expect(result.current.resolvedTheme).toBe("light");

      act(() => {
        simulateSystemThemeChange(true);
      });

      // Should still be light — not listening to system changes
      expect(result.current.resolvedTheme).toBe("light");
    });
  });

  describe("ThemeProvider", () => {
    it("renders children", () => {
      const { getByText } = render(
        <ThemeProvider>
          <div>Hello Theme</div>
        </ThemeProvider>,
      );

      expect(getByText("Hello Theme")).toBeInTheDocument();
    });

    it("applies .dark class to <html> when resolved theme is dark", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });

    it("removes .dark class from <html> when resolved theme is light", () => {
      // Pre-set dark class to verify removal
      document.documentElement.classList.add("dark");

      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("light");
      });

      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });

    it("toggles .dark class when system preference changes", () => {
      mockDarkMode = false;
      renderHook(() => useTheme(), { wrapper });
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      act(() => {
        simulateSystemThemeChange(true);
      });

      expect(document.documentElement.classList.contains("dark")).toBe(true);

      act(() => {
        simulateSystemThemeChange(false);
      });

      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });

  describe("matchMedia listener lifecycle", () => {
    it("registers a change listener when theme is 'system'", () => {
      renderHook(() => useTheme(), { wrapper });

      expect(mockMediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    });

    it("removes the change listener when theme switches away from 'system'", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });

      expect(mockMediaQuery.removeEventListener).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      );
    });

    it("re-registers listener when switching back to 'system'", () => {
      const { result } = renderHook(() => useTheme(), { wrapper });

      act(() => {
        result.current.setTheme("dark");
      });
      mockMediaQuery.addEventListener.mockClear();

      act(() => {
        result.current.setTheme("system");
      });

      expect(mockMediaQuery.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    });
  });

  describe("setTheme reference stability", () => {
    it("setTheme function reference is stable across re-renders", () => {
      const { result, rerender } = renderHook(() => useTheme(), { wrapper });

      const firstSetTheme = result.current.setTheme;
      rerender();
      expect(result.current.setTheme).toBe(firstSetTheme);
    });
  });
});
