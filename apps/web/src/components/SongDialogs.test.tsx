import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteSongModal, SongCreateModal } from "./SongDialogs";

describe("SongCreateModal", () => {
  it("creates a complete manual song with multiple lyric sections", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<SongCreateModal onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Firm Foundation" } });
    fireEvent.change(screen.getByLabelText("Artist"), { target: { value: "Maverick City Music" } });
    fireEvent.change(screen.getByLabelText("CCLI number"), { target: { value: "7188203" } });
    fireEvent.change(screen.getByLabelText("BPM"), { target: { value: "75" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "C" } });
    fireEvent.change(screen.getByLabelText("Section 1 lyrics"), { target: { value: "Christ is my firm foundation" } });
    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    fireEvent.change(screen.getByLabelText("Section 2 name"), { target: { value: "Chorus" } });
    fireEvent.change(screen.getByLabelText("Section 2 lyrics"), { target: { value: "He won't fail" } });
    fireEvent.click(screen.getByRole("button", { name: "Create song" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Firm Foundation",
        artist: "Maverick City Music",
        ccliNumber: "7188203",
        bpm: 75,
        keySignature: "C",
        sections: [
          { label: "Verse 1", lyrics: "Christ is my firm foundation" },
          { label: "Chorus", lyrics: "He won't fail" },
        ],
      });
    });
  });

  it("keeps the form open and displays creation errors", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("A song with this title already exists."));
    render(<SongCreateModal onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Duplicate" } });
    fireEvent.change(screen.getByLabelText("Section 1 lyrics"), { target: { value: "Lyrics" } });
    fireEvent.click(screen.getByRole("button", { name: "Create song" }));

    expect((await screen.findByRole("alert")).textContent).toContain("A song with this title already exists.");
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("formats a full pasted song and submits the exact display-ready arrangement", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<SongCreateModal onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Paste Test" } });
    fireEvent.click(screen.getByRole("button", { name: "Paste and format" }));
    fireEvent.change(screen.getByLabelText("Paste the full song"), {
      target: { value: "Verse 1\nOne\nTwo\nThree\nFour\nFive\n\nChorus\nSix\nSeven" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Format arrangement" }));

    const firstName = screen.getByLabelText("Section 1 name");
    const firstLyrics = screen.getByLabelText("Section 1 lyrics");
    const secondName = screen.getByLabelText("Section 2 name");
    const thirdName = screen.getByLabelText("Section 3 name");
    if (!(firstName instanceof HTMLInputElement) || !(firstLyrics instanceof HTMLTextAreaElement) || !(secondName instanceof HTMLInputElement) || !(thirdName instanceof HTMLInputElement)) throw new Error("Expected lyric form controls");
    expect(firstName.value).toBe("Verse 1 1/2");
    expect(firstLyrics.value).toBe("One\nTwo\nThree\nFour");
    expect(secondName.value).toBe("Verse 1 2/2");
    expect(thirdName.value).toBe("Chorus");
    expect(screen.getByRole("status").textContent).toContain("3 sections formatted");

    fireEvent.click(screen.getByRole("button", { name: "Create song" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        title: "Paste Test",
        artist: "",
        ccliNumber: "",
        bpm: null,
        keySignature: "",
        sections: [
          { label: "Verse 1 1/2", lyrics: "One\nTwo\nThree\nFour" },
          { label: "Verse 1 2/2", lyrics: "Five" },
          { label: "Chorus", lyrics: "Six\nSeven" },
        ],
      });
    });
  });

  it("converts clipboard text to clean plain lyrics", () => {
    render(<SongCreateModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const lyrics = screen.getByLabelText("Section 1 lyrics");
    if (!(lyrics instanceof HTMLTextAreaElement)) throw new Error("Expected lyrics textarea");

    fireEvent.paste(lyrics, {
      clipboardData: { getData: () => "  First\u00a0line  \r\nSecond   line\r\n\r\n\r\nThird\u200B line  " },
    });

    expect(lyrics.value).toBe("First line\nSecond line\n\nThird line");
  });
});

describe("DeleteSongModal", () => {
  it("states the deletion scope and confirms the action", () => {
    const onDelete = vi.fn();
    render(<DeleteSongModal title="Firm Foundation" sectionCount={3} cueMapCount={2} busy={false} error={null} onClose={vi.fn()} onDelete={onDelete} />);

    expect(screen.getByText(/3 sections/)).not.toBeNull();
    expect(screen.getByText(/2 cue maps/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete song" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
