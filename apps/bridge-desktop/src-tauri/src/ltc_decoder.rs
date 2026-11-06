use serde::{Deserialize, Serialize};
use timecode_tools::{decoder::Decoder, label::Label};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum LtcRate {
    #[serde(rename = "24-ndf")]
    Fps24,
    #[serde(rename = "25-ndf")]
    Fps25,
    #[serde(rename = "29.97-ndf")]
    Fps2997,
    #[serde(rename = "29.97-df")]
    Fps2997Drop,
    #[serde(rename = "30-ndf")]
    Fps30,
}
impl LtcRate {
    pub fn fps(self) -> f64 {
        match self {
            Self::Fps24 => 24.,
            Self::Fps25 => 25.,
            Self::Fps2997 | Self::Fps2997Drop => 29.97,
            Self::Fps30 => 30.,
        }
    }
    fn nominal(self) -> u32 {
        self.fps().round() as u32
    }
    fn drop(self) -> bool {
        self == Self::Fps2997Drop
    }
    fn accepts(self, label: Label) -> bool {
        label.hours < 24
            && label.minutes < 60
            && label.seconds < 60
            && u32::from(label.frames) < self.nominal()
            && label.drop_frame == self.drop()
            && !(label.drop_frame
                && label.minutes % 10 != 0
                && label.seconds == 0
                && label.frames < 2)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Timecode {
    pub hours: u8,
    pub minutes: u8,
    pub seconds: u8,
    pub frames: u8,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Format {
    pub frame_rate: f64,
    pub drop_frame: &'static str,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LtcFrame {
    pub timecode: Timecode,
    pub format: Format,
    pub total_frames: i64,
}
impl LtcFrame {
    pub fn display(&self) -> String {
        format!(
            "{:02}:{:02}:{:02}{}{:02}",
            self.timecode.hours,
            self.timecode.minutes,
            self.timecode.seconds,
            if self.format.drop_frame == "df" {
                ';'
            } else {
                ':'
            },
            self.timecode.frames
        )
    }
}

/// Decoding is independent of the audio driver. A sample gap resets acquisition.
/// Only changed, coherent labels reach the relay; silence never creates a clock.
pub struct LtcDecoder {
    decoder: Decoder,
    rate: LtcRate,
    last: Option<i64>,
}
impl LtcDecoder {
    pub fn new(sample_rate: u32, rate: LtcRate) -> Result<Self, String> {
        if !(16_000..=192_000).contains(&sample_rate) {
            return Err("LTC requires audio between 16 kHz and 192 kHz.".into());
        }
        Ok(Self {
            decoder: Decoder::new(sample_rate),
            rate,
            last: None,
        })
    }
    pub fn feed(&mut self, first_sample: u64, pcm: &[i16]) -> Vec<LtcFrame> {
        if self.decoder.sample_index != first_sample {
            self.last = None;
        }
        self.decoder
            .feed_at(first_sample, pcm)
            .into_iter()
            .filter_map(|decoded| {
                let label = decoded.frame.label;
                if !decoded.locked
                    || decoded.estimated_fps != Some(self.rate.nominal())
                    || !self.rate.accepts(label)
                {
                    return None;
                }
                let total = label.frame_index(self.rate.nominal());
                if self.last == Some(total) {
                    return None;
                }
                self.last = Some(total);
                Some(LtcFrame {
                    timecode: Timecode {
                        hours: label.hours,
                        minutes: label.minutes,
                        seconds: label.seconds,
                        frames: label.frames,
                    },
                    format: Format {
                        frame_rate: self.rate.fps(),
                        drop_frame: if self.rate.drop() { "df" } else { "ndf" },
                    },
                    total_frames: total,
                })
            })
            .collect()
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    // Independent BCD/bi-phase-mark fixture generator. It does not use the
    // decoder dependency's synthesizer or its frame arithmetic.
    pub fn waveform(labels: &[[u8; 4]], sample_rate: u32, fps: f64, drop: bool) -> Vec<i16> {
        let mut samples = Vec::new();
        let mut level = 20_000i16;
        let mut half_index = 0u64;
        for [hours, minutes, seconds, frames] in labels {
            let mut bits = [false; 80];
            for (start, value, width) in [
                (0, frames % 10, 4),
                (8, frames / 10, 2),
                (16, seconds % 10, 4),
                (24, seconds / 10, 3),
                (32, minutes % 10, 4),
                (40, minutes / 10, 3),
                (48, hours % 10, 4),
                (56, hours / 10, 2),
            ] {
                for bit in 0..width {
                    bits[start + bit] = value & (1 << bit) != 0;
                }
            }
            bits[10] = drop;
            for (index, bit) in [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
                .iter()
                .enumerate()
            {
                bits[64 + index] = *bit == 1;
            }
            for bit in bits {
                level = -level;
                for half in 0..2 {
                    if half == 1 && bit {
                        level = -level;
                    }
                    half_index += 1;
                    let end =
                        (half_index as f64 * sample_rate as f64 / (fps * 160.)).round() as usize;
                    samples.resize(end, level);
                }
            }
        }
        samples
    }
    fn decode(samples: &[i16], sample_rate: u32, rate: LtcRate, chunk: usize) -> Vec<LtcFrame> {
        let mut decoder = LtcDecoder::new(sample_rate, rate).unwrap();
        let mut first = 0;
        samples
            .chunks(chunk)
            .flat_map(|block| {
                let frames = decoder.feed(first, block);
                first += block.len() as u64;
                frames
            })
            .collect()
    }
    #[test]
    fn decodes_independent_pcm_at_supported_rates_and_arbitrary_callback_boundaries() {
        for (rate, fps) in [
            (LtcRate::Fps24, 24.),
            (LtcRate::Fps25, 25.),
            (LtcRate::Fps2997, 30000. / 1001.),
            (LtcRate::Fps2997Drop, 30000. / 1001.),
            (LtcRate::Fps30, 30.),
        ] {
            let labels: Vec<_> = (0..20).map(|frame| [1, 2, 3, frame]).collect();
            for sample_rate in [44100, 48000, 96000] {
                let pcm = waveform(&labels, sample_rate, fps, rate.drop());
                for chunk in [1, 127, 512, 4096] {
                    let decoded = decode(&pcm, sample_rate, rate, chunk);
                    assert!(
                        decoded.len() >= 12,
                        "{rate:?}/{sample_rate}/{chunk}: {}",
                        decoded.len()
                    );
                    assert_eq!(
                        decoded.last().unwrap().timecode,
                        Timecode {
                            hours: 1,
                            minutes: 2,
                            seconds: 3,
                            frames: 18
                        }
                    );
                    assert!(decoded
                        .windows(2)
                        .all(|pair| pair[1].total_frames == pair[0].total_frames + 1));
                }
            }
        }
    }
    #[test]
    fn accepts_polarity_inversion_and_low_level_pcm_but_not_silence_or_stopped_labels() {
        let labels: Vec<_> = (0..20).map(|frame| [0, 0, 1, frame]).collect();
        let pcm = waveform(&labels, 48000, 30., false);
        let quieter: Vec<_> = pcm.iter().map(|value| -value / 8).collect();
        assert_eq!(
            decode(&pcm, 48000, LtcRate::Fps30, 512),
            decode(&quieter, 48000, LtcRate::Fps30, 512)
        );
        assert!(decode(&[0; 48000], 48000, LtcRate::Fps30, 512).is_empty());
        assert!(decode(
            &waveform(&[[0, 0, 1, 0]; 20], 48000, 30., false),
            48000,
            LtcRate::Fps30,
            512
        )
        .is_empty());
    }
    #[test]
    fn sample_loss_requires_fresh_acquisition_and_wrong_format_never_fires() {
        let labels: Vec<_> = (0..20).map(|frame| [0, 0, 1, frame]).collect();
        let pcm = waveform(&labels, 48000, 30., false);
        assert!(decode(&pcm, 48000, LtcRate::Fps25, 512).is_empty());
        assert!(decode(&pcm, 48000, LtcRate::Fps2997Drop, 512).is_empty());
        let mut decoder = LtcDecoder::new(48000, LtcRate::Fps30).unwrap();
        assert!(!decoder.feed(0, &pcm[..16000]).is_empty());
        assert!(decoder.feed(24000, &pcm[24000..25600]).is_empty());
        assert!(!decoder.feed(25600, &pcm[25600..]).is_empty());
    }
    #[test]
    fn rejects_invalid_labels_and_preserves_drop_frame_rollover_math() {
        for label in [
            Label {
                hours: 24,
                minutes: 0,
                seconds: 0,
                frames: 0,
                drop_frame: false,
            },
            Label {
                hours: 0,
                minutes: 1,
                seconds: 0,
                frames: 1,
                drop_frame: true,
            },
        ] {
            assert!(!LtcRate::Fps2997Drop.accepts(label));
        }
        let labels = [
            [0, 0, 59, 24],
            [0, 0, 59, 25],
            [0, 0, 59, 26],
            [0, 0, 59, 27],
            [0, 0, 59, 28],
            [0, 0, 59, 29],
            [0, 1, 0, 2],
            [0, 1, 0, 3],
            [0, 1, 0, 4],
            [0, 1, 0, 5],
            [0, 1, 0, 6],
            [0, 1, 0, 7],
        ];
        let frames = decode(
            &waveform(&labels, 48000, 30000. / 1001., true),
            48000,
            LtcRate::Fps2997Drop,
            127,
        );
        assert!(frames.iter().any(|frame| frame.timecode.minutes == 1
            && frame.timecode.frames == 2
            && frame.total_frames == 1800));
        assert!(frames
            .windows(2)
            .all(|pair| pair[1].total_frames == pair[0].total_frames + 1));
    }
}
