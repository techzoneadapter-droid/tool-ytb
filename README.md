# StoryFlow — dựng video từ tài nguyên thật

Next.js + TypeScript, SQLite, FFmpeg. Không tự tạo dự án mẫu; không có nhánh tạo giọng im lặng hay ảnh màu giả lập. Chức năng tách chương được giữ nguyên.

## Chạy

Cần Node.js 22.13+ (khuyên dùng 24), FFmpeg và ffprobe trên PATH, FFmpeg có libx264/libass.

```sh
npm install
npm run dev
# Hoặc: npm run app
```

Mở http://127.0.0.1:3000. Chạy bản tối ưu: `npm run build`, `npm start` (worker tự chạy). Chỉ chạy một worker. Mặc định ứng dụng chỉ lắng nghe localhost, chưa có đăng nhập; không triển khai nguyên trạng ra Internet.

## Desktop and background Flow

Run `npm run build`, then `npm run desktop`. If the development server is already running on port 3000, desktop reuses it. Closing the desktop window hides it to the system tray; workers continue processing. The tray menu reopens the window or exits the interface. This is a desktop runtime in the repository, not a packaged installer.

Flow now uses the Python backend in `workers/flow_automation.py` and `workers/flow_server.py`. Install it with `python -m venv .flow-venv`, then `.flow-venv\Scripts\python.exe -m pip install -r workers/flow-requirements.txt`. The service starts automatically from the app. `FLOW_PYTHON` can select another Python environment.

In the Flow panel, paste the JSON array exported by EditThisCookie and the URL of an existing Flow project, then connect. After successful authentication, validated cookies are saved atomically in `cookies.json` (or `FLOW_COOKIES_FILE`), which is excluded from Git. Cookie values are never logged or returned to the frontend. The frontend clears the cookie field after successful import. The worker restores the saved cookie file on startup; expired or rejected cookies require a fresh import. Explicit disconnect removes the saved file. A failed cookie replacement removes the previous saved session. The browser uses `headless=True` with the installed Chrome channel by default, without accessing the personal profile or CDP. Cookie import does not guarantee Google accepts the new session; login redirects, unconfirmed authentication and missing projects produce distinct errors.

`await initialize_session(cookie_json)` normalizes EditThisCookie fields, starts the browser, imports cookies, opens Flow and verifies readiness. `await generate_image(prompt)` confirms image mode/model/aspect/x1, fills the ProseMirror editor, clicks `Bắt đầu tạo`, waits for a new image and returns `(bytes, mime)` for the video pipeline. `await close()` releases browser resources while preserving the saved cookie file for restart. Configuration controls are activated with JavaScript DOM events, without Playwright pointer clicks. Prompt ambiguity, rejected input and submit failures have distinct `FLOW_PROMPT_INPUT`/`FLOW_PROMPT_SUBMIT` stages and screenshot/HTML/JSON diagnostics. React internal handler properties and ProseMirror state access can change between Flow versions; live Flow validation is still required. The saved HTML does not contain the closed settings menu, so live menu variations still need verification. `npm run test:flow:python` checks cookie handling, session cleanup and a local simulated composer without spending Flow credits.

## Giọng đọc local miễn phí

Nâng cấp local AI: xem [LOCAL_AI_WORKERS.md](docs/LOCAL_AI_WORKERS.md) để dùng VieNeu làm giọng chính, FLUX.2 tạo ảnh và Wan2.2 tạo clip tùy chọn. Ảnh động mặc định tắt; video ảnh tĩnh vẫn chạy như cũ.

Engine mặc định cho dự án mới là **VieNeu-TTS v3 Turbo**. Có thêm **KorvaTTS** với 10 giọng dựng sẵn. Xem [hướng dẫn cài đặt và nghe thử Ngọc Huyền](docs/LOCAL_TTS.md). Chọn giọng trong nhóm **Local miễn phí**, nghe thử rồi lưu thiết lập dự án; worker dùng đúng engine đã chọn. Dự án cũ giữ lựa chọn cloud cho đến khi bạn đổi giọng.

## Cấu hình API thật (tùy chọn)

Sao chép `.env.example` thành `.env.local`. Không gửi khóa vào chat hoặc commit vào Git. Khởi động lại **cả server và worker** sau khi sửa biến môi trường.

### Lựa chọn A: OpenAI TTS và OpenAI Images

```dotenv
OPENAI_API_KEY=your_real_key
TTS_PROVIDER=openai
TTS_MODEL=tts-1
TTS_VOICE_MAP={}
IMAGE_PROVIDER=openai
IMAGE_MODEL=gpt-image-1
```

Chọn một giọng mang nhãn **OpenAI** ở Giọng đọc (alloy, echo, fable, onyx, nova, shimmer). Đây là giọng có sẵn, không phải giọng Ngọc Huyền. Có thể dùng hai khóa riêng bằng `TTS_API_KEY` và `IMAGE_API_KEY`; mỗi khóa ưu tiên hơn `OPENAI_API_KEY`.

Adapter gọi trực tiếp:

- POST `https://api.openai.com/v1/audio/speech`, nhận MP3 thật.
- POST `https://api.openai.com/v1/images/generations`, nhận ảnh base64, giải mã và lưu PNG thật.
- GPT Image cần quyền truy cập model và hạn mức tài khoản phù hợp. Mã không kiểm chứng khóa chỉ từ việc biến môi trường đã được đặt.

### Lựa chọn B: Azure Speech tiếng Việt và OpenAI Images

```dotenv
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=your_real_azure_key
AZURE_SPEECH_REGION=southeastasia
TTS_VOICE_MAP={"hoai-my":"vi-VN-HoaiMyNeural"}
IMAGE_PROVIDER=openai
IMAGE_API_KEY=your_real_openai_key
IMAGE_MODEL=gpt-image-1
```

Chọn **Hoài My**. Adapter lấy danh mục giọng của vùng Azure, kiểm tra mã giọng tồn tại rồi gửi SSML đến `https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`, nhận MP3 thật. Không tự tạo hoặc sao chép giọng cá nhân.

**Ngọc Huyền trong nhóm API đám mây:** chỉ cấu hình `"ngoc-huyen":"<mã giọng được cấp quyền>"` khi có mã tương ứng thực sự; không gán alloy/Hoài My vào Ngọc Huyền. Nhóm **Local miễn phí** dùng ID `ngoc_huyen` của VieNeu hoặc Korva và không cần `TTS_VOICE_MAP`.

Các biến khác:

- `TEXT_MODEL=gpt-4o-mini`: viết lại/tóm tắt qua OpenAI, cần `OPENAI_API_KEY`; giữ nguyên nội dung không cần API viết.
- `FFMPEG_PATH=ffmpeg`, `FFPROBE_PATH=ffprobe`: tên lệnh hoặc đường dẫn chương trình.
- `TTS_VOICE_MAP`: JSON từ mã cấu hình trong `modules/tts/voices.ts` tới mã giọng có thật. Không chứa khóa API.

Tài liệu chính thức: [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech), [OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation), [Azure Speech REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech).

## Workflow mới — 3 tab

1. **Nhập truyện**: dán nội dung hoặc kéo/thả TXT/DOCX, xem trước chương rồi tạo dự án. Không chạy AI tại bước này. Danh sách dự án có mở, đổi tên và xóa có xác nhận; xóa bản ghi không xóa tệp dùng chung.
2. **Tạo video**: chọn dự án/chương, VieNeu hoặc Korva, nghe thử, bật/tắt lời đọc, ảnh, phụ đề và ảnh động. Mặc định VieNeu/Ngọc Huyền, FLUX.2, phụ đề bật và Wan tắt. Chọn 16:9 hoặc 9:16, xuất riêng từng chương hoặc gộp theo thứ tự truyện.
3. **Quản lý kênh**: YouTube/Facebook ghi rõ Đang phát triển; chưa có liên kết hoặc OAuth.

**Bắt đầu tạo video** lưu tùy chọn rồi chạy pipeline trên worker. Audio, ảnh và motion hợp lệ được tái sử dụng. Tiến trình lấy từ tác vụ/cảnh và FFmpeg. Lỗi có Chi tiết; retry giữ phần đã xong. Duyệt thủ công nằm trong Thiết lập nâng cao, mặc định tắt. MP4 chỉ hoàn thành sau ffprobe; player và tải MP4/SRT nằm ngay dưới cấu hình.

Tắt tạo ảnh: dùng ảnh đã có hoặc tải Ảnh dùng chung cho cảnh thiếu ảnh. Tắt lời đọc: dùng audio đã có, báo lỗi khi thiếu. Engine local lỗi không chuyển sang dịch vụ trả phí. Thiết lập nâng cao giữ pitch, volume, pause, prompt, phụ đề, intro/outro, logo và nhạc nền.

`npm run app`, `npm run dev` và `npm start` dùng launcher chung, giữ worker lock và heartbeat. Không chạy thêm terminal worker. FLUX/Wan cần được cài và tải model trước; FLUX chỉ đọc model có sẵn, không tự tải hàng chục GB. Xem `docs/LOCAL_AI_WORKERS.md` và `docs/LOCAL_TTS.md`.
## Lưu trữ, phạm vi

- SQLite `data/storyflow.sqlite`, file `data/assets`, trung gian `data/work`; sao lưu cả thư mục.
- Chỉ một worker, tạm dừng ở công đoạn hiện tại hoặc lần cập nhật FFmpeg kế tiếp. Nếu dừng cưỡng bức, lần khởi động sau tự phục hồi lock khi PID đã chết. Khởi động lại sẽ phục hồi tác vụ dang dở; gọi lại dịch vụ có thể phát sinh phí.
- Phụ đề dựa trên thời lượng audio đo thật nhưng chia theo số từ, chưa có nhận dạng lời nói/căn từng từ.
- Mở đầu/kết thúc có hình với nền âm thanh im lặng theo thiết kế cũ; **lời đọc cảnh luôn phải đến từ TTS thật**. Nhạc nền/biểu trưng tùy chọn.
- YouTube/Facebook Page/Lịch đăng/Thống kê vẫn **Đang phát triển**.
- Chưa có hạn ngạch đĩa, tự dọn file cũ, xác thực người dùng, thử lại API có backoff hoặc thanh toán.
- Không xóa dự án người dùng chỉ vì trùng tên. Script dọn một lần `scripts/remove-legacy-media.mjs` chỉ nhận diện kết quả từ chế độ cũ, giữ văn bản/chương và ảnh tải lên không phải nền màu. Không chạy script này khi khởi động.

## Kiểm tra

```sh
npm test
npm run build
node scripts/verify-real-media.mjs
```

Chưa có script lint. Bộ kiểm thử parser vẫn giữ nguyên. Kiểm thử mới kiểm tra cấu hình thiếu khóa, không gán giọng giả, 10 prompt ảnh khác nhau.

Script trình duyệt dùng Microsoft Edge đã cài trên máy, tạo một dự án kiểm thử tạm rồi xóa đúng bản ghi đó. Không chạm nội dung dự án người dùng. Có khóa và mã giọng thì kiểm tra nghe thử, tạo MP3/ảnh, duyệt, xuất MP4, player, tải file, refresh. Khi thiếu khóa, chỉ kiểm tra lỗi rõ ràng, prompt Tu tiên và chặn render; ghi rõ **chưa kiểm tra đầu ra AI end-to-end**, không dựng video giả để thay thế. Kết quả lưu ở `test-results/real-media-results.json`.

Kiểm tra TTS local ngày 02/10/2026: KorvaTTS 0.1.3 trong `.tts-venv` đã tạo WAV/MP3 thật, trình duyệt nhận thời lượng dương, tải được file sau refresh; worker tạo audio cảnh bằng `korva-local`, cache trả cùng nội dung file. Ở kiểm thử ban đầu VieNeu chưa chạy; kiểm thử mới phía dưới đã khởi động và xác minh WAV thật. Không gọi API đám mây trong kiểm tra local này.

Kiểm tra lại sau khi chạy server và worker: `node scripts/verify-local-tts.mjs --audio`, `node scripts/verify-local-pipeline.mjs`. Cần Edge và Korva đã cấu hình; script pipeline chỉ tạo rồi xóa dự án kiểm thử riêng, không sửa truyện có sẵn.

## Các module

`modules/providers/config.ts`: cấu hình và trạng thái không chứa khóa; `modules/tts`: giọng và API TTS; `modules/imagePrompt`: prompt hệ thống và API ảnh; `modules/project/media.ts`: xác minh tài nguyên; `modules/videoRender`: FFmpeg; `scripts/worker.ts`: hàng đợi; `app/api/tts/preview`: nghe thử; `app/api/studio`: thao tác dự án/cảnh/tác vụ.

## Kiểm chứng workflow một nút — 02/10/2026

- Korva tạo audio mới: cold load 18,27 giây; các lượt sau `model_loads=1`, `load_seconds=0` (6,25 và 12,79 giây tổng hợp hai đoạn khác nhau). Không dùng batch: ONNX của Korva cố định batch size 1.
- VieNeu khởi động từ app, sửa lỗi kế thừa PORT của Next.js; WAV mới 3,877 giây đã được xác minh.
- Browser one-click: hai chương → Korva thật → ảnh chụp rừng tải lên → SRT → MP4 10,12 giây. Player, Range HTTP 206, download, refresh và tái sử dụng tài nguyên đều qua. Ảnh tải lên không được tính là test suy luận FLUX.
- `npm test`: 17/17 PASS; `npm run build`: PASS. Các script local TTS, local pipeline, local AI, real-media (nhánh thiếu khóa cloud), studio-panel, one-click và recovery đã PASS.
- Recovery: hai lỗi FLUX không làm dừng tạo audio các cảnh khác; retry giữ audio; duyệt tùy chọn; resume qua khởi động lại worker; không tạo worker trùng; tắt phụ đề không tạo SRT/VTT.
- FLUX/Wan chưa kiểm thử suy luận thật: máy chưa có môi trường `.ai-venv`; chưa xác minh dependencies, model và CUDA cho hai engine. Lỗi được giữ nguyên, không có ảnh/video AI giả.
- Báo cáo và video TEST giữ trong `test-results/one-click.json`, `test-results/recovery.json` và các dự án có tiền tố `[TEST ...]`. Không sửa truyện người dùng.

Kiểm thử bổ sung: `node scripts/verify-one-click.mjs`, `node scripts/verify-recovery.mjs`. Cần ảnh chụp thật tại `test-results/forest-photo.jpg` (fixture lần này: https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1280&q=80). Recovery kiểm tra tình huống FLUX chưa khả dụng. Các script tạo dự án riêng; không dùng dữ liệu truyện thật.

## Kiểm chứng redesign — 03/10/2026

- 3 tab mới; TXT/DOCX, preview parser, lưu/đổi tên dự án: PASS. Edge 1366×768 và 1600×900: không lỗi console/hydration, không tràn ngang.
- VieNeu và Korva: WAV thật, ffprobe thời lượng dương, cache trả cùng audio. Không gọi TTS cloud.
- Pipeline: MP4 riêng 2 chương và MP4 gộp đúng thứ tự, phụ đề SRT, player, download, Range 206 và refresh: PASS. Dùng ảnh chụp tải lên; không tính là FLUX inference.
- Retry giữ audio, resume sau restart, lock không trùng, duyệt riêng nhiều chương và invalidation khi đổi giọng: PASS.
- FLUX.2/Wan2.2: INTEGRATION ONLY. Real inference SKIPPED vì engine/môi trường chưa sẵn sàng. Pipeline Wan đã được kiểm tra thực sự gọi adapter và trả lỗi thật.
- `npm test`: 18/18 PASS. `npm run build`: PASS; còn cảnh báo tracing đường dẫn động của launcher trong Turbopack.

Kiểm tra UI: `node scripts/verify-redesign.mjs`. Kiểm tra thật: `verify-local-tts.mjs`, `verify-local-pipeline.mjs`, `verify-local-ai.mjs`, `verify-real-media.mjs`, `verify-one-click.mjs`, `verify-recovery.mjs`, `verify-chapter-review.mjs` trong `scripts/`. Cần app chạy; các script tạo dự án TEST riêng, không dùng truyện có sẵn. Báo cáo và ảnh chụp trong `test-results/`. Hai test phục hồi chỉ restart worker sau khi xác nhận không có job đang chạy.
