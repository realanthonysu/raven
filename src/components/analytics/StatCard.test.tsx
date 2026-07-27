import { render, screen } from "@testing-library/react";
import { BarChart3 } from "lucide-react";
import { describe, expect, it } from "vitest";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders label and value", () => {
    render(<StatCard icon={BarChart3} label="批改篇数" value="128" />);
    expect(screen.getByText("批改篇数")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
  });

  it("renders sub text when provided", () => {
    render(<StatCard icon={BarChart3} label="总错误" value="45" sub="本周 -5" />);
    expect(screen.getByText("本周 -5")).toBeInTheDocument();
  });

  it("does not render sub text when not provided", () => {
    const { container } = render(<StatCard icon={BarChart3} label="总错误" value="45" />);
    expect(container.querySelectorAll("p")).toHaveLength(1); // Only value, no sub
  });

  it("applies custom subColor", () => {
    render(<StatCard icon={BarChart3} label="test" value="1" sub="info" subColor="text-red-600" />);
    const subEl = screen.getByText("info");
    expect(subEl).toHaveClass("text-red-600");
  });

  it("applies default green color for sub", () => {
    render(<StatCard icon={BarChart3} label="test" value="1" sub="info" />);
    const subEl = screen.getByText("info");
    expect(subEl).toHaveClass("text-green-600");
  });
});
