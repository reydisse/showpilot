import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeleteSongModal, SongCreateModal } from "./SongDialogs";

describe("SongCreateModal", () => {
  it("retains the exact creation request when closed and reopened after a lost reply", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("Reply lost")).mockResolvedValueOnce({ id: "same-song" });
    const onOpenSong = vi.fn().mockResolvedValue(undefined);
    const props = { orgId: "org", onClose: vi.fn(), onCreate, onOpenSong };
    const { rerender } = render(<SongCreateModal {...props} open />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep this title" } });
    fireEvent.change(screen.getByLabelText("Section 1 lyrics"), { target: { value: "One\nTwo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create song" }));
    await screen.findByRole("button", { name: "Retry creation" });
    expect(screen.getByLabelText("Title").closest("fieldset")?.disabled).toBe(true);
    rerender(<SongCreateModal {...props} open={false} />);
    rerender(<SongCreateModal {...props} open />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry creation" }));
    await waitFor(() => expect(onOpenSong).toHaveBeenCalledWith("same-song", expect.any(AbortSignal)));
    expect(onCreate.mock.calls[1][0]).toEqual(onCreate.mock.calls[0][0]);
    expect(onCreate.mock.calls[1][1]).toBe(onCreate.mock.calls[0][1]);
    expect(onCreate.mock.calls[1][0].sections[0].lyrics).toBe("One\nTwo");
  });

  it("retries opening a confirmed song without creating another one", async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: "created-once" });
    const onOpenSong = vi.fn().mockRejectedValueOnce(new Error("Route failed")).mockResolvedValueOnce(undefined);
    render(<SongCreateModal orgId="org" open onClose={vi.fn()} onCreate={onCreate} onOpenSong={onOpenSong} />);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "One song" } });
    fireEvent.change(screen.getByLabelText("Section 1 lyrics"), { target: { value: "Lyrics" } });
    fireEvent.click(screen.getByRole("button", { name: "Create song" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry opening song" }));
    await waitFor(() => expect(onOpenSong).toHaveBeenCalledTimes(2));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("dismisses with Escape through the shared modal behavior", async () => {
    const onClose = vi.fn();
    render(<SongCreateModal orgId="org" open onOpenSong={vi.fn().mockResolvedValue(undefined)} onClose={onClose} onCreate={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("creates a complete manual song with multiple lyric sections", async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: "created" });
    render(<SongCreateModal orgId="org" open onOpenSong={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onCreate={onCreate} />);

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
      }, expect.any(String), expect.any(AbortSignal));
    });
  });

  it("keeps the form open and displays creation errors", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("A song with this title already exists."));
    render(<SongCreateModal orgId="org" open onOpenSong={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Duplicate" } });
    fireEvent.change(screen.getByLabelText("Section 1 lyrics"), { target: { value: "Lyrics" } });
    fireEvent.click(screen.getByRole("button", { name: "Create song" }));

    expect((await screen.findByRole("alert")).textContent).toContain("A song with this title already exists.");
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("formats a full pasted song and submits the exact display-ready arrangement", async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: "created" });
    render(<SongCreateModal orgId="org" open onOpenSong={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onCreate={onCreate} />);

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
      }, expect.any(String), expect.any(AbortSignal));
    });
  });

  it("converts clipboard text to clean plain lyrics", () => {
    render(<SongCreateModal orgId="org" open onOpenSong={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onCreate={vi.fn()} />);
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
