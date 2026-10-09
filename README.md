# StoryFlow — dựng video từ tài nguyên thật

Next.js + TypeScript, SQLite, FFmpeg. Không tự tạo dự án mẫu; không có nhánh tạo giọng im lặng hay ảnh màu giả lập. Chức năng tách chương được giữ nguyên.

## Chế độ hiện tại: một ảnh tải lên cho toàn bộ video

Trong **Tạo video → Ảnh cho toàn bộ video**, tải một ảnh PNG/JPG/WebP. App lưu ảnh theo từng dự án và sử dụng ảnh đó cho tất cả cảnh, chương và video của dự án; có thể thay hoặc xóa ảnh tại đây. Phải chọn ảnh hợp lệ trước khi chạy. Đổi ảnh sẽ làm mất hiệu lực cache video/ảnh động cũ khi dựng lại, audio hợp lệ được giữ lại.

Ứng dụng không tạo ảnh bằng API, Flow hay engine local. Giao diện kết nối/tạo ảnh đã bỏ; endpoint ảnh cũ trả HTTP 410 và hàng đợi cũ cũng chuyển sang ảnh tải lên. Giọng đọc, phụ đề, nhạc, logo, intro/outro, tỷ lệ khung hình, ảnh động tùy chọn, tiến độ, retry, xuất từng chương/gộp video được giữ nguyên. Các mục Flow/API ảnh và báo cáo cũ bên dưới là tài liệu của phiên bản trước, không còn là hướng dẫn sử dụng tính năng tạo ảnh trong app hiện tại.

## Bộ cài Windows và cập nhật

Tải `StoryFlow-Setup-<version>-x64.exe` ở [GitHub Releases](https://github.com/techzoneadapter-droid/tool-ytb/releases/latest), chạy bộ cài rồi mở StoryFlow từ Desktop/Start Menu. Bộ cài kèm Node.js và FFmpeg/FFprobe; Edge TTS dùng thư viện đã đóng gói, không chạy npx hay tải npm lúc đọc. Các engine VieNeu/Korva/Wan local vẫn dùng môi trường/model đã thiết lập của bạn.

Nút **Cập nhật** ở thanh bên kiểm tra bản phát hành ổn định, tải bản mới có kiểm tra SHA512, chờ các tác vụ đang chạy hoàn thành, sao lưu SQLite rồi cài và mở lại app. Dữ liệu mặc định nằm tại `%APPDATA%/StoryFlow/workspace/data`, tệp sao lưu tại `workspace/backups`. Để dùng lại bản chạy mã nguồn, bấm **Chọn thư mục dữ liệu** và chọn thư mục repo cũ chứa `data/storyflow.sqlite` cùng `.env.local`/các môi trường Python của bạn; không cần chuyển hay xóa dữ liệu.

Mỗi lần sửa code trên `main`, GitHub Actions tạo phiên bản `1.0.<số lần chạy>`, build, cài một bản cũ trên Windows, dựng MP4 bằng FFmpeg rồi nâng cấp qua chính nút trong app. Chỉ khi kiểm tra giữ dữ liệu sau nâng cấp đạt, quy trình mới phát hành EXE, blockmap và `latest.yml`. Cập nhật nhận bản phát hành, không cài trực tiếp các commit chưa build.

## Tự cài VieNeu trên desktop

Sau cập nhật, dự án chọn VieNeu Local được tự thiết lập Python, thư viện và model khi mở app. Tiến độ từng giai đoạn hiển thị tại Tạo video; có nút **Cài và khởi động VieNeu** để thử lại. Lần đầu cần mạng để tải model; các lần sau dùng môi trường/model đã lưu trong thư mục dữ liệu. Cấu hình mặc định chạy CPU ONNX fp32. Xem [LOCAL_TTS.md](docs/LOCAL_TTS.md).

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

`await initialize_session(cookie_json)` normalizes cookies and verifies authentication and composer readiness. Health separates `sessionReady`, `composerReady`, `generationReady`, `lastStage` and `lastError`. The current Flow project owns its model/aspect/output count; generating a scene never opens settings or calls `_configure()`.

Prompt submission runs inside `page.evaluate()`: native textarea/input setters or ProseMirror/contenteditable updates, `beforeinput`/`input`/`change`, then `form.requestSubmit()`, DOM click, MouseEvent and private React handler as the last available fallback. Each prompt is dispatched once. The worker confirms generation through a cleared composer, new loading/result state or an outgoing Google request containing the prompt. A no-op submission reports `FLOW_SUBMIT_FAILED`; accepted requests without a new result report `FLOW_GENERATION_TIMEOUT`.

The scene pipeline preserves the existing TTS engine, receives image bytes as a Node Buffer, writes that Buffer directly to FFmpeg stdin (`image2pipe` plus `tpad`), verifies the MP4, checkpoints the scene and immediately creates its Video Manager record. Scene previews have subtitle sidecars; chapter assembly reuses the saved clips and keeps the existing subtitle/music/logo/intro/outro processing. No Flow PNG/JPG or image base64 is saved in project storage. Scene checkpoints contain IDs, stage, prompt, voice state, video path, render identity, error code/message and update time. Retry reuses verified scene MP4s; changed prompts/text/voice/aspect invalidate their render identity. Interrupted scenes remain retryable after restart.

`FLOW_CONCURRENCY=1` by default, capped at 2. A global slot covers generation through encoding so concurrent chapter jobs cannot accumulate image buffers. `FLOW_RENDER_CONCURRENCY` separately bounds encoding (default 2, cap 4). The single browser session serializes actual Flow submissions. Model/ratio settings remain those saved in the user's Flow project; FFmpeg crops to the requested output aspect.

`FLOW_DEBUG=1` enables failure-only screenshots, HTML and metadata under `data/flow-debug/`. The default writes no debug images. Cookie values are never logged. `data/flow-session.json` stores only the project URL for restoration; `cookies.json` stays local and excluded from Git.

Run `npm test`, `npm run test:flow:python`, `npm run test:flow`, and `npm run build`. Browser fixture tests cover event/submit/result plumbing, not proof of the live Flow DOM. The integration suite uses real FFmpeg/SQLite in an isolated temporary directory and checks independent failures, checkpointing, retry and absence of intermediate images. Run `npm run smoke:flow:scene` for one real Flow/TTS scene; it creates a separate smoke project and publishes its MP4. If an older worker holds cookies only in RAM and there is no saved cookie file, smoke reports `FLOW_LOGIN_REQUIRED` at `FLOW_SESSION_RESTORE` and leaves the old process untouched.

## Giọng đọc local miễn phí

Nâng cấp local AI: xem [LOCAL_AI_WORKERS.md](docs/LOCAL_AI_WORKERS.md) để dùng VieNeu làm giọng chính, FLUX.2 tạo ảnh và Wan2.2 tạo clip tùy chọn. Ảnh động mặc định tắt; video ảnh tĩnh vẫn chạy như cũ.

Engine mặc định cho dự án mới là **VieNeu-TTS v3 Turbo**. Có thêm **KorvaTTS** với 10 giọng dựng sẵn. Xem [hướng dẫn cài đặt và nghe thử Ngọc Huyền](docs/LOCAL_TTS.md). Chọn giọng trong nhóm **Local miễn phí**, nghe thử rồi lưu thiết lập dự án; worker dùng đúng engine đã chọn. Dự án cũ giữ lựa chọn cloud cho đến khi bạn đổi giọng.

## Cấu hình API thật (tùy chọn)

Sao chép `.env.example` thành `.env.local`. Không gửi khóa vào chat hoặc commit vào Git. Khởi động lại **cả server và worker** sau khi sửa biến môi trường.

Trong **Tạo video → Ảnh minh họa → Engine ảnh**, chọn OpenAI/GPT Image, Google Gemini/Nano Banana hoặc Stability AI, dán API key rồi bấm **Kết nối & lấy danh sách model**. Chọn model trong danh sách vừa tải. OpenAI/Gemini lấy danh sách từ API; Stability kiểm tra key qua API tài khoản rồi hiển thị hai endpoint Core/Ultra được hỗ trợ. Kết nối không phát sinh yêu cầu tạo ảnh và không xác nhận hạn mức tạo ảnh.

Key được lưu cục bộ trong `data/image-api/<provider>.json` (đã loại khỏi Git), không trả về trình duyệt. Cấu hình từ giao diện ưu tiên hơn biến môi trường; cả server và worker đọc thay đổi ngay, không cần khởi động lại. Không đưa key vào thiết lập dự án, localStorage hoặc log. Model được chọn lưu cùng thiết lập dự án khi bắt đầu tạo video để worker dùng đúng lựa chọn. Mỗi API tạo một ảnh cho mỗi cảnh cần ảnh; kết quả được giải mã, cắt theo tỷ lệ video và dùng trong luồng dựng video hiện có.

| Lựa chọn | API key trong `.env.local` | Model |
| --- | --- | --- |
| OpenAI · GPT Image | `OPENAI_API_KEY` hoặc `IMAGE_API_KEY` | `OPENAI_IMAGE_MODEL`, rồi `IMAGE_MODEL`; mặc định `gpt-image-1` |
| Google Gemini · Nano Banana | `GEMINI_API_KEY` hoặc `GOOGLE_API_KEY` | `GEMINI_IMAGE_MODEL=gemini-3.1-flash-image` |
| Stability AI · Stable Image | `STABILITY_API_KEY` | `STABILITY_IMAGE_MODEL=core` hoặc `ultra` |

Key chỉ được đọc ở server/worker; giao diện phân biệt có key với đã kết nối API. Không tự chuyển sang API trả phí khác khi một API lỗi. Endpoint tạo ảnh riêng `/api/image/generate` cũng nhận `provider: "openai"`, `"gemini"` hoặc `"stability"` và `model` tùy chọn.

Gemini dùng [Interactions API](https://ai.google.dev/gemini-api/docs/image-generation) và chỉ lấy ảnh kết quả cuối, bỏ ảnh suy nghĩ trung gian. Stability gọi [Stable Image Core/Ultra](https://platform.stability.ai/docs/api-reference). [Imagen đã ngừng cung cấp trên Gemini API](https://ai.google.dev/gemini-api/docs/imagen). Tài liệu [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/) mô tả nhận ảnh đầu vào; chưa có API xuất ảnh được xác minh để thêm vào danh sách tạo ảnh.

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
2. **Tạo video**: chọn dự án/chương, VieNeu hoặc Korva, nghe thử, tải một ảnh dùng chung, bật/tắt lời đọc, phụ đề và ảnh động. Mặc định VieNeu/Ngọc Huyền, phụ đề bật và Wan tắt. Chọn 16:9 hoặc 9:16, xuất riêng từng chương hoặc gộp theo thứ tự truyện.
3. **Quản lý kênh**: YouTube/Facebook ghi rõ Đang phát triển; chưa có liên kết hoặc OAuth.

**Bắt đầu tạo video** lưu tùy chọn rồi chạy pipeline trên worker. Audio, ảnh và motion hợp lệ được tái sử dụng. Tiến trình lấy từ tác vụ/cảnh và FFmpeg. Lỗi có Chi tiết; retry giữ phần đã xong. Duyệt thủ công nằm trong Thiết lập nâng cao, mặc định tắt. MP4 chỉ hoàn thành sau ffprobe; player và tải MP4/SRT nằm ngay dưới cấu hình.

Ảnh dùng chung tải lên là nguồn ảnh duy nhất cho mọi cảnh và chương. Tắt lời đọc: dùng audio đã có, báo lỗi khi thiếu. Engine local lỗi không chuyển sang dịch vụ trả phí. Thiết lập nâng cao giữ pitch, volume, pause, prompt, phụ đề, intro/outro, logo và nhạc nền.

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

## API ảnh theo chương và đồng nhất nhân vật

Trong **Tạo video → Engine ảnh**, chọn GPT Image, Gemini, Stability hoặc **Image API · OpenAI compatible**. Nhập key và kết nối để lấy model. Engine riêng yêu cầu Base URL có `/models`, `/images/generations` và `/images/edits` khi bật reference; chọn đúng model ảnh, không dùng GLM/DeepSeek chỉ trả văn bản. Có thể cấu hình qua `API_IMAGE_KEY`, `API_IMAGE_BASE_URL`, `API_IMAGE_MODEL` trong `.env.local`; cấu hình UI được ưu tiên và lưu tại `data/image-api/` đã loại khỏi Git.

Mỗi chương chỉ tạo một ảnh master cho toàn bộ cảnh. Worker trích ý đồ hình ảnh, bối cảnh, thời gian, mood, hành động và nhân vật trung tâm bằng heuristic; chương mơ hồ dùng establishing shot. Character Bible chuẩn hóa toàn dự án; có thể chỉnh JSON danh tính và `normalizedPrompt` trong **Nhân vật, bối cảnh và prompt ảnh**. Thuộc tính chưa xuất hiện trong truyện được đánh dấu chưa xác định, không được coi là dữ kiện đã trích xuất.

GPT Image/Gemini native image dùng portrait nhân vật chính đã lưu để conditioning qua API reference. Engine riêng có checkbox capability theo tài liệu model; mặc định không giả định có reference/seed/negative. Stability Core dùng text consistency, seed và negative prompt; Ultra hỗ trợ thêm một portrait qua image-to-image với mức thay đổi reference tùy chỉnh. Portrait được tạo một lần theo danh tính/model/style và dùng lại giữa các chương; `primary` trong Bible xác định nhân vật cần portrait. Đây là cơ chế conditioning giúp giữ nhân diện, không phải bảo đảm mọi model giữ mặt giống tuyệt đối.

Ảnh API base64/bytes/URL được lưu thành PNG tại `data/assets`, publish vào `public/generated/images` rồi đưa trực tiếp vào FFmpeg. Project JSON trong SQLite giữ `characterBible`, `chapter.imageAnalysis`, `chapter.apiImage`; record kind `image_generation_history` giữ metadata mỗi ảnh. Không cần migration SQL vì schema records hiện có lưu JSON. Debug trong cấu hình ảnh hiển thị prompt cuối, negative, character block, metadata và usage số thật do API trả; không tự suy ra credit/chi phí từ token.

Cache khóa theo nội dung/danh tính/style/model/tham số ảnh. Đổi timeout/retry/concurrency/debug không gọi API lại. Lỗi 429/5xx/timeout retry exponential backoff theo cấu hình (mặc định 2); 400/401/403 không retry. Retry timeout có thể bị tính phí thêm nếu nhà cung cấp đã xử lý yêu cầu. Video chương được lưu ngay khi hoàn thành; lỗi một chương không dừng các job còn lại. Flow vẫn giữ luồng Buffer legacy.

Chạy `npm run dev`; kiểm tra bằng `npm test`, `npm run test:flow`, `npm run build`. Test worker sử dụng API fixture, DB riêng trong thư mục tạm và FFmpeg thật, xác minh portrait dùng chung, lỗi riêng từng chương, video library và retry không tạo lại ảnh thành công.

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
