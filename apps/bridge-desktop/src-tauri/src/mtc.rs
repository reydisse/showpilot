// Pure MIDI decoding, shared by the Bridge callback and standalone regression tests.
#[derive(Clone, Debug, PartialEq)]
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

    fn transport_frame(decoder: &mut MtcTransportDecoder, frame: u8) -> Option<MtcEvent> {
        let mut result = None;
        for (index, value) in [frame & 15, frame >> 4, 0, 0, 0, 0, 0, 6]
            .iter()
            .enumerate()
        {
            if let Some(event) = decoder.feed(&[0xf1, (index as u8) << 4 | value]) {
                result = Some(event);
            }
        }
        result
    }

    #[test]
    fn transport_stop_blocks_frames_until_continue_and_a_fresh_position() {
        let mut decoder = MtcTransportDecoder::default();
        assert!(matches!(
            transport_frame(&mut decoder, 1),
            Some(MtcEvent::Frame(_))
        ));
        assert_eq!(decoder.feed(&[0xfc]), Some(MtcEvent::Stopped));
        assert_eq!(transport_frame(&mut decoder, 2), None);
        decoder.reconnect();
        assert_eq!(transport_frame(&mut decoder, 3), None);
        assert_eq!(decoder.feed(&[0xfb]), Some(MtcEvent::Waiting));
        assert_eq!(transport_frame(&mut decoder, 4), None);
        assert_eq!(decoder.feed(&[0xf8]), None);
        assert_eq!(decoder.feed(&[0xf2, 3, 0]), Some(MtcEvent::Waiting));
        assert_eq!(decoder.feed(&[0xf8]), None);
        assert!(
            matches!(transport_frame(&mut decoder, 5), Some(MtcEvent::Frame(frame)) if frame.frames == 5)
        );
        assert_eq!(transport_frame(&mut decoder, 5), None);
    }

    #[test]
    fn start_implies_song_position_zero_but_needs_absolute_timecode() {
        let mut decoder = MtcTransportDecoder::default();
        assert_eq!(decoder.feed(&[0xfa]), Some(MtcEvent::Waiting));
        for _ in 0..24 {
            assert_eq!(decoder.feed(&[0xf8]), None);
        }
        assert_eq!(decoder.song_position_clocks, Some(24));
        assert!(matches!(
            transport_frame(&mut decoder, 0),
            Some(MtcEvent::Frame(_))
        ));
    }

    #[test]
    fn full_frame_sync_can_locate_while_stopped_without_firing() {
        let mut decoder = MtcTransportDecoder::default();
        decoder.feed(&[0xfc]);
        assert_eq!(
            decoder.feed(&[0xf0, 0x7f, 0x7f, 1, 1, 0x60, 0, 0, 7, 0xf7]),
            None
        );
        decoder.feed(&[0xfb]);
        assert!(
            matches!(transport_frame(&mut decoder, 7), Some(MtcEvent::Frame(frame)) if frame.frames == 7)
        );
        decoder.feed(&[0xfc]);
        decoder.feed(&[0xfb]);
        assert!(
            matches!(decoder.feed(&[0xf0, 0x7f, 0x7f, 1, 1, 0x60, 0, 0, 8, 0xf7]), Some(MtcEvent::Frame(frame)) if frame.frames == 8)
        );
    }

    #[test]
    fn invalid_or_directed_positions_never_release_waiting_transport() {
        let mut decoder = MtcTransportDecoder::default();
        decoder.feed(&[0xfb]);
        for message in [
            vec![0xf2, 128, 0],
            vec![0xf2, 0],
            vec![0xf0, 0x7f, 1, 1, 1, 0x60, 0, 0, 1, 0xf7],
            vec![0xf0, 0x7f, 0x7f, 1, 1, 0x40, 1, 0, 0, 0xf7],
        ] {
            assert_eq!(decoder.feed(&message), None);
        }
        assert_eq!(transport_frame(&mut decoder, 3), None);
    }

    #[test]
    fn stop_and_locate_discard_incomplete_quarter_cycles() {
        let mut decoder = MtcTransportDecoder::default();
        for (i, value) in AFTER.iter().enumerate().take(4) {
            decoder.feed(&[0xf1, (i as u8) << 4 | value]);
        }
        decoder.feed(&[0xfc]);
        decoder.feed(&[0xfa]);
        for (i, value) in AFTER.iter().enumerate().skip(4) {
            assert_eq!(decoder.feed(&[0xf1, (i as u8) << 4 | value]), None);
        }
        assert!(matches!(
            transport_frame(&mut decoder, 4),
            Some(MtcEvent::Frame(_))
        ));
    }

    #[test]
    fn full_frame_supports_all_rates_and_rejects_invalid_labels() {
        for (rate, fps, drop) in [
            (0, 24.0, "ndf"),
            (1, 25.0, "ndf"),
            (2, 29.97, "df"),
            (3, 30.0, "ndf"),
        ] {
            let mut decoder = MtcTransportDecoder::default();
            assert!(
                matches!(decoder.feed(&[0xf0, 0x7f, 0x7f, 1, 1, rate << 5, 0, 0, 4, 0xf7]), Some(MtcEvent::Frame(frame)) if frame.frame_rate == fps && frame.drop_frame == drop)
            );
            assert_eq!(
                decoder.feed(&[0xf0, 0x7f, 0x7f, 1, 1, rate << 5, 0, 0, 30, 0xf7]),
                None
            );
        }
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
        if message.len() != 2 || message[0] != 0xF1 {
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
        decode_frame(hours, minutes, seconds, frames, rate_code)
    }
}

fn decode_frame(
    hours: u32,
    minutes: u32,
    seconds: u32,
    frames: u32,
    rate_code: u8,
) -> Option<MtcFrame> {
    let (frame_rate, drop_frame, nominal_fps) = match rate_code {
        0 => (24.0, "ndf", 24_u32),
        1 => (25.0, "ndf", 25_u32),
        2 => (29.97, "df", 30_u32),
        _ => (30.0, "ndf", 30_u32),
    };
    if hours > 23 || minutes > 59 || seconds > 59 || frames >= nominal_fps {
        return None;
    }
    if drop_frame == "df" && minutes % 10 != 0 && seconds == 0 && frames < 2 {
        return None;
    }
    let raw =
        hours * nominal_fps * 3600 + minutes * nominal_fps * 60 + seconds * nominal_fps + frames;
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

#[derive(Default)]
enum Transport {
    #[default]
    Free,
    Stopped,
    Waiting,
    Running,
}

#[derive(Debug, PartialEq)]
pub(crate) enum MtcEvent {
    Frame(MtcFrame),
    Stopped,
    Waiting,
}

/// Transport and absolute timecode are separate: MIDI beats never become
/// SMPTE using an assumed tempo. A locate must be followed by valid MTC.
#[derive(Default)]
pub(crate) struct MtcTransportDecoder {
    quarter: MtcQuarterFrameDecoder,
    transport: Transport,
    position_known: bool,
    song_position_clocks: Option<u32>,
    last_frame: Option<MtcFrame>,
}

impl MtcTransportDecoder {
    pub(crate) fn reconnect(&mut self) {
        self.quarter = MtcQuarterFrameDecoder::default();
        self.last_frame = None;
        // In particular, reconnecting a USB cable must not release DAW Stop.
    }

    pub(crate) fn feed(&mut self, message: &[u8]) -> Option<MtcEvent> {
        match message {
            [0xfc] => {
                self.reconnect();
                self.transport = Transport::Stopped;
                self.position_known = false;
                return Some(MtcEvent::Stopped);
            }
            [0xfa] | [0xfb] => {
                self.reconnect();
                if message[0] == 0xfa {
                    self.song_position_clocks = Some(0);
                    self.position_known = true;
                }
                self.transport = Transport::Waiting;
                return Some(MtcEvent::Waiting);
            }
            [0xf2, low, high] if *low < 128 && *high < 128 => {
                self.reconnect();
                self.song_position_clocks = Some((u32::from(*low) | (u32::from(*high) << 7)) * 6);
                self.position_known = true;
                if !matches!(self.transport, Transport::Stopped) {
                    self.transport = Transport::Waiting;
                    return Some(MtcEvent::Waiting);
                }
                return None;
            }
            [0xf8] => {
                if !matches!(self.transport, Transport::Stopped) {
                    if let Some(ticks) = self.song_position_clocks.as_mut() {
                        *ticks = ticks.saturating_add(1);
                    }
                }
                return None;
            }
            _ => {}
        }
        let frame = match message {
            [0xf0, 0x7f, 0x7f, 1, 1, hour, minute, second, frame, 0xf7] => {
                self.quarter = MtcQuarterFrameDecoder::default();
                if [*hour, *minute, *second, *frame]
                    .iter()
                    .any(|byte| *byte > 127)
                {
                    return None;
                }
                let frame = decode_frame(
                    u32::from(hour & 31),
                    u32::from(*minute),
                    u32::from(*second),
                    u32::from(*frame),
                    (hour >> 5) & 3,
                )?;
                self.position_known = true;
                frame
            }
            _ => self.quarter.feed(message)?,
        };
        if matches!(self.transport, Transport::Stopped)
            || (matches!(self.transport, Transport::Waiting) && !self.position_known)
        {
            return None;
        }
        if self.last_frame.as_ref() == Some(&frame) {
            return None;
        }
        if matches!(self.transport, Transport::Waiting) {
            self.transport = Transport::Running;
        }
        self.last_frame = Some(frame.clone());
        Some(MtcEvent::Frame(frame))
    }
}
