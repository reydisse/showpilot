// ShowPilot macOS confidence output. One explicit channel per host; never change
// DeckLink profiles or connector mappings belonging to another application.
// Future NDI: consume the same CVPixelBuffer source behind a separate output
// adapter. Do not add it to DeckLink's scheduled-frame callback or SDK lifetime.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include "decklink-sdk/DeckLinkAPI.h"
#include <atomic>
#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

static char *json(id value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String ?: "{}");
}
static NSString *takeString(CFStringRef value) {
    return value ? CFBridgingRelease(value) : @"";
}
template<class T> struct Release { void operator()(T *p) const { if (p) p->Release(); } };
template<class T> using ComPtr = std::unique_ptr<T, Release<T>>;

static std::string deviceKey(IDeckLink *device) {
    IDeckLinkProfileAttributes *raw = nullptr;
    if (device->QueryInterface(IID_IDeckLinkProfileAttributes, (void **)&raw) != S_OK) return "";
    ComPtr<IDeckLinkProfileAttributes> attributes(raw);
    int64_t id = 0, sub = 0, duplex = 0;
    if (raw->GetInt(BMDDeckLinkPersistentID, &id) != S_OK) return "";
    raw->GetInt(BMDDeckLinkSubDeviceIndex, &sub);
    if (raw->GetInt(BMDDeckLinkDuplex, &duplex) == S_OK && duplex == bmdDuplexInactive) return "";
    return std::to_string(id) + ":" + std::to_string(sub);
}
static bool supports(IDeckLinkOutput *output, BMDDisplayMode mode) {
    bool supported = false;
    BMDDisplayMode actualMode = bmdModeUnknown;
    // Query only the CURRENT profile. Listing modes from another profile would
    // falsely promise an output and could disrupt ProPresenter on enable.
    return output->DoesSupportVideoMode(bmdVideoConnectionSDI, mode, bmdFormat8BitBGRA,
        bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actualMode, &supported) == S_OK && supported;
}

extern "C" char *sp_decklink_inventory() {
    @autoreleasepool {
        NSMutableArray *devices = [NSMutableArray array];
        ComPtr<IDeckLinkIterator> iterator(CreateDeckLinkIteratorInstance());
        if (!iterator) return json(@{@"devices": devices, @"error": @"Install Blackmagic Desktop Video to use DeckLink output."});
        IDeckLink *deviceRaw = nullptr;
        while (iterator->Next(&deviceRaw) == S_OK) {
            ComPtr<IDeckLink> device(deviceRaw);
            std::string key = deviceKey(deviceRaw);
            if (key.empty()) continue;
            IDeckLinkOutput *outputRaw = nullptr;
            if (deviceRaw->QueryInterface(IID_IDeckLinkOutput, (void **)&outputRaw) != S_OK) continue;
            ComPtr<IDeckLinkOutput> output(outputRaw);
            IDeckLinkDisplayModeIterator *modesRaw = nullptr;
            if (output->GetDisplayModeIterator(&modesRaw) != S_OK) continue;
            ComPtr<IDeckLinkDisplayModeIterator> modes(modesRaw);
            NSMutableArray *formats = [NSMutableArray array];
            IDeckLinkDisplayMode *modeRaw = nullptr;
            while (modes->Next(&modeRaw) == S_OK) {
                ComPtr<IDeckLinkDisplayMode> mode(modeRaw);
                if (!supports(outputRaw, mode->GetDisplayMode())) continue;
                CFStringRef name = nullptr; mode->GetName(&name);
                BMDTimeValue duration = 0; BMDTimeScale scale = 0;
                if (mode->GetFrameRate(&duration, &scale) != S_OK || duration <= 0 || scale <= 0) continue;
                [formats addObject:@{@"id": @(mode->GetDisplayMode()), @"name": takeString(name),
                    @"width": @(mode->GetWidth()), @"height": @(mode->GetHeight()),
                    @"frameDuration": @(duration), @"timeScale": @(scale)}];
            }
            CFStringRef name = nullptr; device->GetDisplayName(&name);
            [devices addObject:@{@"id": @(key.c_str()), @"name": takeString(name), @"modes": formats}];
        }
        return json(@{@"devices": devices, @"error": [NSNull null]});
    }
}

// The hardware clock owns frame scheduling. Capture may deliver frames only
// when content changes; repeat the last complete image at the exact mode rate.
class Playback final : public IDeckLinkVideoOutputCallback {
    std::atomic<ULONG> refs{1};
    std::atomic<bool> active{false};
    bool enabled = false, stopped = false;
    std::mutex pixelsMutex, scheduleMutex;
    CVPixelBufferRef latest = nullptr;
    ComPtr<IDeckLinkOutput> output;
    std::vector<ComPtr<IDeckLinkMutableVideoFrame>> frames;
    BMDTimeValue duration = 0, index = 0;
    BMDTimeScale scale = 0;
public:
    int width = 0, height = 0;
    std::atomic<uint64_t> dropped{0}, completed{0};
    std::atomic<bool> failed{false};
    HRESULT QueryInterface(REFIID iid, LPVOID *result) override {
        if (!result) return E_INVALIDARG;
        auto unknown = CFUUIDGetUUIDBytes(IUnknownUUID);
        if (memcmp(&iid, &IID_IDeckLinkVideoOutputCallback, sizeof(REFIID)) == 0 || memcmp(&iid, &unknown, sizeof(REFIID)) == 0) {
            *result = static_cast<IDeckLinkVideoOutputCallback *>(this); AddRef(); return S_OK;
        }
        *result = nullptr; return E_NOINTERFACE;
    }
    ULONG AddRef() override { return ++refs; }
    ULONG Release() override { ULONG count = --refs; if (!count) delete this; return count; }
    ~Playback() { stop(); if (latest) CVPixelBufferRelease(latest); }
    std::string configure(const std::string &key, BMDDisplayMode modeId) {
        ComPtr<IDeckLinkIterator> iterator(CreateDeckLinkIteratorInstance());
        if (!iterator) return "Blackmagic Desktop Video is unavailable.";
        IDeckLink *raw = nullptr;
        while (iterator->Next(&raw) == S_OK) {
            ComPtr<IDeckLink> device(raw);
            if (deviceKey(raw) != key) continue;
            IDeckLinkOutput *out = nullptr;
            if (raw->QueryInterface(IID_IDeckLinkOutput, (void **)&out) != S_OK) break;
            output.reset(out); break;
        }
        if (!output) return "This DeckLink channel is no longer available. Refresh the device list.";
        if (!supports(output.get(), modeId)) return "This format is unavailable in the card's current profile. Refresh the format list.";
        IDeckLinkDisplayMode *rawMode = nullptr;
        if (output->GetDisplayMode(modeId, &rawMode) != S_OK || !rawMode) return "Could not read the output format.";
        ComPtr<IDeckLinkDisplayMode> mode(rawMode);
        width = mode->GetWidth(); height = mode->GetHeight();
        mode->GetFrameRate(&duration, &scale);
        if (width <= 0 || height <= 0 || duration <= 0 || scale <= 0) return "Invalid output format.";
        if (output->EnableVideoOutput(modeId, bmdVideoOutputFlagDefault) != S_OK)
            return "Could not reserve this channel. It may be in use by ProPresenter or another app.";
        enabled = true;
        for (int i = 0; i < 3; ++i) {
            IDeckLinkMutableVideoFrame *frame = nullptr;
            if (output->CreateVideoFrame(width, height, width * 4, bmdFormat8BitBGRA, bmdFrameFlagDefault, &frame) != S_OK)
                return "Could not allocate video frames for this format.";
            frames.emplace_back(frame);
        }
        return "";
    }
    CMTime interval() { return CMTimeMake(duration, (int32_t)scale); }
    bool update(CVPixelBufferRef buffer) {
        if (CVPixelBufferGetWidth(buffer) != (size_t)width || CVPixelBufferGetHeight(buffer) != (size_t)height || CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA) return false;
        std::lock_guard<std::mutex> lock(pixelsMutex);
        CVPixelBufferRetain(buffer);
        if (latest) CVPixelBufferRelease(latest);
        latest = buffer;
        return true;
    }
    bool schedule(IDeckLinkVideoFrame *frame) {
        void *bytes = nullptr;
        if (frame->GetBytes(&bytes) != S_OK || !bytes) return false;
        {
            std::lock_guard<std::mutex> lock(pixelsMutex);
            if (latest && CVPixelBufferLockBaseAddress(latest, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess) {
                auto *source = (uint8_t *)CVPixelBufferGetBaseAddress(latest);
                size_t stride = CVPixelBufferGetBytesPerRow(latest);
                for (int row = 0; row < height; ++row)
                    memcpy((uint8_t *)bytes + row * frame->GetRowBytes(), source + row * stride, width * 4);
                CVPixelBufferUnlockBaseAddress(latest, kCVPixelBufferLock_ReadOnly);
            } else memset(bytes, 0, frame->GetRowBytes() * height);
        }
        return output->ScheduleVideoFrame(frame, index++ * duration, duration, scale) == S_OK;
    }
    bool start() {
        std::lock_guard<std::mutex> lock(scheduleMutex);
        if (stopped) return false;
        if (active.exchange(true)) return true;
        if (output->SetScheduledFrameCompletionCallback(this) != S_OK) return false;
        for (auto &frame : frames) if (!schedule(frame.get())) return false;
        return output->StartScheduledPlayback(0, scale, 1.0) == S_OK;
    }
    HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame *frame, BMDOutputFrameCompletionResult result) override {
        std::lock_guard<std::mutex> lock(scheduleMutex);
        if (!active) return S_OK;
        ++completed;
        if (result == bmdOutputFrameDropped || result == bmdOutputFrameDisplayedLate) {
            ++dropped;
            BMDTimeValue streamTime = 0; double speed = 0;
            if (output->GetScheduledStreamTime(scale, &streamTime, &speed) == S_OK)
                index = std::max(index, streamTime / duration + 2);
        }
        if (result == bmdOutputFrameFlushed || !schedule(frame)) failed = true;
        return S_OK;
    }
    HRESULT ScheduledPlaybackHasStopped() override { if (active) failed = true; return S_OK; }
    void stop() {
        { std::lock_guard<std::mutex> lock(scheduleMutex); active = false; stopped = true; }
        if (output && enabled) {
            enabled = false;
            output->StopScheduledPlayback(0, nullptr, scale > 0 ? scale : 60000);
            output->SetScheduledFrameCompletionCallback(nullptr);
            output->DisableVideoOutput();
        }
    }
};

@interface SPCapture : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
    ComPtr<Playback> playback;
    std::atomic<bool> cancelled;
    std::atomic<bool> hasFrame;
    uint64_t lastCompleted;
    unsigned stalledChecks;
}
@property(nonatomic, strong) SCStream *stream API_AVAILABLE(macos(12.3));
@property(nonatomic, copy) NSString *state;
@property(nonatomic, copy) NSString *message;
- (void)watch;
- (void)stop;
- (void)fail:(NSString *)message;
@end

@implementation SPCapture
- (instancetype)init { if ((self = [super init])) { cancelled = false; hasFrame = false; lastCompleted = 0; stalledChecks = 0; self.state = @"starting"; self.message = @"Preparing video output…"; } return self; }
- (void)watch {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (self->cancelled) return;
        if (self->hasFrame && self->playback) {
            uint64_t count = self->playback->completed.load();
            self->stalledChecks = count == self->lastCompleted ? self->stalledChecks + 1 : 0;
            self->lastCompleted = count;
            if (self->playback->failed || self->stalledChecks >= 5) {
                [self fail:@"DeckLink stopped delivering frames. Check the card connection and channel, then enable output again."]; return;
            }
        }
        [self watch];
    });
}
- (void)stop {
    cancelled = true;
    if (@available(macOS 14.0, *)) [self.stream stopCaptureWithCompletionHandler:^(NSError *) {}];
    if (playback) playback->stop();
    if (@available(macOS 14.0, *)) self.stream = nil;
}
- (void)fail:(NSString *)message {
    // Lifecycle runs on main. Capture / DeckLink callbacks never tear down a
    // stream from inside its own callback.
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self->cancelled) return;
        self.state = @"error"; self.message = message; [self stop];
    });
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error API_AVAILABLE(macos(12.3)) {
    [self fail:@"The output window stopped delivering video. Disable and re-enable the output."];
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type API_AVAILABLE(macos(12.3)) {
    if (@available(macOS 14.0, *)) {
    if (cancelled || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    CFArrayRef rawAttachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSArray *attachments = (__bridge NSArray *)rawAttachments;
    NSNumber *status = [attachments.firstObject objectForKey:SCStreamFrameInfoStatus];
    if (status && (status.integerValue == SCFrameStatusBlank || status.integerValue == SCFrameStatusSuspended || status.integerValue == SCFrameStatusStopped)) {
        [self fail:@"The confidence window is unavailable. Keep it open and unminimized while output is enabled."]; return;
    }
    if (status && status.integerValue != SCFrameStatusComplete && status.integerValue != SCFrameStatusStarted) return;
    CVPixelBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (!image || !playback) return;
    if (!playback->update(image)) { [self fail:@"The output source does not match the selected video format."]; return; }
    if (!hasFrame.exchange(true)) {
        if (!playback->start()) { [self fail:@"DeckLink could not start scheduled playback."]; return; }
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self->cancelled) return;
            self.state = @"running"; self.message = @"Output enabled";
        });
    }
    }
}
@end

// Owned exclusively by the macOS main queue. Stops/restarts cannot overlap.
static SPCapture *session = nil;
static void onMain(dispatch_block_t block) {
    if ([NSThread isMainThread]) block(); else dispatch_sync(dispatch_get_main_queue(), block);
}
extern "C" char *sp_decklink_status() {
    __block char *result = nullptr;
    onMain(^{
        if (session && session->playback && session->playback->failed && !session->cancelled) {
            session.state = @"error"; session.message = @"DeckLink playback stopped. Check the channel and card profile, then enable output again."; [session stop];
        }
        result = json(@{@"state": session.state ?: @"stopped", @"message": session.message ?: @"Output disabled",
            @"droppedFrames": @(session && session->playback ? session->playback->dropped.load() : 0),
            @"completedFrames": @(session && session->playback ? session->playback->completed.load() : 0)});
    });
    return result;
}
extern "C" void sp_decklink_stop() {
    onMain(^{ [session stop]; session = nil; });
}
extern "C" void sp_decklink_start(const char *key, uint32_t mode, void *nativeWindow) {
    std::string device(key);
    onMain(^{
        [session stop];
        SPCapture *capture = [[SPCapture alloc] init]; session = capture;
        if (@available(macOS 14.0, *)) {
            if (!CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess()) {
                capture.state = @"error"; capture.message = @"Allow ShowPilot in System Settings → Privacy & Security → Screen Recording, then try again."; return;
            }
            capture->playback.reset(new Playback());
            std::string error = capture->playback->configure(device, mode);
            if (!error.empty()) { capture.state = @"error"; capture.message = @(error.c_str()); [capture stop]; return; }
            [capture watch];
            NSWindow *window = (__bridge NSWindow *)nativeWindow;
            CGWindowID windowId = (CGWindowID)window.windowNumber;
            [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (capture->cancelled) return;
                    SCWindow *source = nil;
                    for (SCWindow *candidate in content.windows) if (candidate.windowID == windowId && candidate.owningApplication.processID == getpid()) { source = candidate; break; }
                    if (!source || error) { [capture fail:@"Could not open the ShowPilot output window. Check screen-recording permission and try again."]; return; }
                    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:source];
                    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
                    configuration.width = capture->playback->width;
                    configuration.height = capture->playback->height;
                    configuration.minimumFrameInterval = capture->playback->interval();
                    configuration.pixelFormat = kCVPixelFormatType_32BGRA;
                    configuration.showsCursor = NO;
                    configuration.capturesAudio = NO;
                    configuration.queueDepth = 3;
                    configuration.ignoreShadowsSingleWindow = YES;
                    configuration.ignoreGlobalClipSingleWindow = YES;
                    configuration.scalesToFit = YES;
                    configuration.colorSpaceName = kCGColorSpaceSRGB;
                    capture.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:capture];
                    NSError *addError = nil;
                    BOOL added = [capture.stream addStreamOutput:capture type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_queue_create("tech.showpilot.video", DISPATCH_QUEUE_SERIAL) error:&addError];
                    if (!added) { [capture fail:@"Could not prepare the output video stream."]; return; }
                    [capture.stream startCaptureWithCompletionHandler:^(NSError *startError) {
                        if (startError) [capture fail:@"Could not start video capture. Check screen-recording permission and restart ShowPilot if requested by macOS."];
                    }];
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                        if (!capture->cancelled && !capture->hasFrame) [capture fail:@"The output window did not deliver a frame. Keep it open and unminimized, then try again."];
                    });
                });
            }];
        } else { capture.state = @"error"; capture.message = @"DeckLink confidence output requires macOS 14 or later."; }
    });
}
extern "C" void sp_decklink_free(char *text) { free(text); }
