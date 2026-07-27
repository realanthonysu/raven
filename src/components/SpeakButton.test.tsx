import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakButton } from "./SpeakButton";

const mockToggle = vi.fn();

vi.mock("@/hooks/use-audio-player", () => ({
  useAudioPlayer: () => ({
    playing: false,
    loading: false,
    toggle: mockToggle,
  }),
}));

describe("SpeakButton", () => {
  it("renders a button with volume icon", () => {
    render(<SpeakButton text="Hello" />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls toggle with text when clicked", () => {
    render(<SpeakButton text="Hello world" />);
    fireEvent.click(screen.getByRole("button"));
    expect(mockToggle).toHaveBeenCalledWith("Hello world");
  });

  it("has correct aria-label when idle", () => {
    render(<SpeakButton text="Hello" />);
    expect(screen.getByLabelText("朗读")).toBeInTheDocument();
  });
});
