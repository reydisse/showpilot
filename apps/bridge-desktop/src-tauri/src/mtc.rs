// Pure MIDI decoding, shared by the Bridge callback and standalone regression tests.
#[derive(Debug, PartialEq)]
pub(crate) struct MtcFrame {
    pub hours: u32,
    pub minutes: u32,
    pub seconds: u32,
    pub frames: u32,
    pub frame_rate: f64,
    pub drop_frame: &'static str,
    pub total_frames: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    // 00:00:59:28 -> 00:01:00:00 makes stale seconds/minutes visible.
    const BEFORE: [u8; 8] = [12, 1, 11, 3, 0, 0, 0, 6];
    const AFTER: [u8; 8] = [0, 0, 0, 0, 1, 0, 0, 6];

    fn feed(
        decoder: &mut MtcQuarterFrameDecoder,
        pieces: &[u8; 8],
        order: &[usize],
    ) -> Vec<MtcFrame> {
        order
            .iter()
            .filter_map(|&piece| decoder.feed(&[0xf1, (piece as u8) << 4 | pieces[piece]]))
            .collect()
    }

    #[test]
    fn publishes_only_one_timestamp_per_complete_cycle() {
        let mut decoder = MtcQuarterFrameDecoder::default();
        assert_eq!(
            feed(&mut decoder, &BEFORE, &[0, 1, 2, 3, 4, 5, 6, 7]).len(),
            1
        );
        let frames = feed(&mut decoder, &AFTER, &[0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].total_frames, 1800);
    }

    #[test]
    fn dropped_pieces_never_reuse_a_previous_timestamp() {
        for missing in 0..8 {
            let mut decoder = MtcQuarterFrameDecoder::default();
            feed(&mut decoder, &BEFORE, &[0, 1, 2, 3, 4, 5, 6, 7]);
            let order: Vec<_> = (0..8).filter(|&i| i != missing).collect();
            assert!(
                feed(&mut decoder, &AFTER, &order).is_empty(),
                "missing {missing}"
            );
            // A clean, complete cycle recovers without stale timestamp pieces.
            let recovered = feed(&mut decoder, &AFTER, &[0, 1, 2, 3, 4, 5, 6, 7]);
            assert_eq!(recovered.len(), 1);
            assert_eq!(recovered[0].total_frames, 1800);
        }
    }

    #[test]
    fn reordered_and_repeated_pieces_do_not_emit() {
        for swapped in 0..7 {
            let mut decoder = MtcQuarterFrameDecoder::default();
            let mut order = [0, 1, 2, 3, 4, 5, 6, 7];
            order.swap(swapped, swapped + 1);
            assert!(feed(&mut decoder, &AFTER, &order).is_empty());
        }
        let mut decoder = MtcQuarterFrameDecoder::default();
        assert!(feed(&mut decoder, &AFTER, &[0, 1, 2, 3, 3, 4, 5, 6, 7]).is_empty());
    }

    #[test]
    fn supports_reverse_and_wraparound_acquisition() {
        for order in [[7, 6, 5, 4, 3, 2, 1, 0], [4, 5, 6, 7, 0, 1, 2, 3]] {
            let mut decoder = MtcQuarterFrameDecoder::default();
            let frames = feed(&mut decoder, &AFTER, &order);
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].total_frames, 1800);
        }
    }

    #[test]
    fn direction_change_requires_a_new_complete_cycle() {
        let mut decoder = MtcQuarterFrameDecoder::default();
        assert!(feed(&mut decoder, &AFTER, &[0, 1, 2, 1, 0, 7, 6, 5, 4]).is_empty());
        let frames = feed(&mut decoder, &AFTER, &[3, 2]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].total_frames, 1800);
    }

    #[test]
    fn preserves_drop_frame_math() {
        let mut decoder = MtcQuarterFrameDecoder::default();
        let frames = feed(
            &mut decoder,
            &[0, 0, 0, 0, 0, 0, 1, 4],
            &[0, 1, 2, 3, 4, 5, 6, 7],
        );
        assert_eq!(frames[0].frame_rate, 29.97);
        assert_eq!(frames[0].drop_frame, "df");
        assert_eq!(frames[0].total_frames, 107_892);
    }
}

#[derive(Default)]
pub(crate) struct MtcQuarterFrameDecoder {
    pieces: [u8; 8],
    received: u8,
    last_piece: Option<usize>,
    direction: Option<Direction>,
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Forward,
    Reverse,
}

impl MtcQuarterFrameDecoder {
    fn begin_sequence(&mut self, piece: usize, value: u8) {
        *self = Self::default();
        self.pieces[piece] = value;
        self.received = 1 << piece;
        self.last_piece = Some(piece);
    }

    pub(crate) fn feed(&mut self, message: &[u8]) -> Option<MtcFrame> {
        if message.len() < 2 || message[0] != 0xF1 {
            return None;
        }
        let piece = (message[1] >> 4) as usize;
        if piece > 7 {
            return None;
        }
        let value = message[1] & 0x0F;
        let Some(previous) = self.last_piece else {
            self.begin_sequence(piece, value);
            return None;
        };
        let direction = if piece == (previous + 1) % 8 {
            Some(Direction::Forward)
        } else if piece == (previous + 7) % 8 {
            Some(Direction::Reverse)
        } else {
            None
        };
        if direction.is_none()
            || (self.direction.is_some() && self.direction != direction)
            || self.received & (1 << piece) != 0
        {
            self.begin_sequence(piece, value);
            return None;
        }
        self.direction = direction;
        self.last_piece = Some(piece);
        self.pieces[piece] = value;
        self.received |= 1 << piece;
        if self.received != 0xFF {
            return None;
        }
        let pieces = self.pieces;
        *self = Self::default();
        let frames = u32::from(pieces[0] | (pieces[1] << 4));
        let seconds = u32::from(pieces[2] | (pieces[3] << 4));
        let minutes = u32::from(pieces[4] | (pieces[5] << 4));
        let hours = u32::from(pieces[6] | ((pieces[7] & 0x01) << 4));
        let rate_code = (pieces[7] >> 1) & 0x03;
        let (frame_rate, drop_frame, nominal_fps) = match rate_code {
            0 => (24.0, "ndf", 24_u32),
            1 => (25.0, "ndf", 25_u32),
            2 => (29.97, "df", 30_u32),
            _ => (30.0, "ndf", 30_u32),
        };
        if hours > 23 || minutes > 59 || seconds > 59 || frames >= nominal_fps {
            return None;
        }
        let raw = hours * nominal_fps * 3600
            + minutes * nominal_fps * 60
            + seconds * nominal_fps
            + frames;
        let total_frames = if drop_frame == "df" {
            raw.saturating_sub(2 * (hours * 60 + minutes - (hours * 60 + minutes) / 10))
        } else {
            raw
        };
        Some(MtcFrame {
            hours,
            minutes,
            seconds,
            frames,
            frame_rate,
            drop_frame,
            total_frames,
        })
    }
}
