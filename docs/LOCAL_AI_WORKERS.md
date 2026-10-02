# StoryFlow: giọng, ảnh và ảnh động local

VieNeu-TTS v3 Turbo là giọng chính; FLUX.2 tạo ảnh tĩnh; Wan2.2 chỉ tạo ảnh động/video ngắn khi bạn bật. FFmpeg và hàng đợi của StoryFlow vẫn dựng video như trước. Không cần chạy FLUX khi tắt tạo ảnh, không cần chạy Wan khi tắt ảnh động. Không tự chuyển từ local sang API trả phí.

## Cấu hình app

Thêm vào `.env.local` rồi khởi động lại `npm run dev` và `npm run worker`:

```dotenv
VIENEU_LOCAL_URL=http://127.0.0.1:8000
DEFAULT_TTS_PROVIDER=vieneu-local
DEFAULT_VIETNAMESE_VOICE=Ngọc Huyền
FLUX2_WORKER_URL=http://127.0.0.1:7861
FLUX2_MODEL=flux2-klein-4b
WAN22_WORKER_URL=http://127.0.0.1:7862
WAN22_MODEL=ti2v-5b
```

Các URL local chỉ nhận loopback. Dự án mới mặc định VieNeu, FLUX.2, ảnh động tắt. Dự án cũ giữ lựa chọn đã lưu; đổi engine tại trang Giọng đọc và màn hình cảnh rồi lưu. Tên `Ngọc Huyền` được chuẩn hóa thành ID nội bộ `ngoc_huyen`; request VieNeu vẫn gửi đúng `voice: "Ngọc Huyền"`.

## VieNeu — giọng chính

```powershell
git clone https://github.com/pnnbao97/VieNeu-TTS.git
cd VieNeu-TTS
uv sync
uv run python -m apps.openai_speech
```

Cần cài `uv` trước nếu chưa có. App gọi `/v1/audio/speech` với model `vieneu-v3-turbo`, input là nội dung cần đọc, voice `Ngọc Huyền`, response_format `wav`. Không có server thì nút Nghe thử hiển thị lệnh chạy. WAV được chuẩn hóa; có thể xuất MP3. Xem thêm [LOCAL_TTS.md](LOCAL_TTS.md) cho Korva dự phòng do người dùng chọn.

## FLUX.2 — tạo ảnh

Worker trong `workers/local_ai.py` định nghĩa giao thức HTTP riêng của StoryFlow; đây không phải endpoint mặc định của ComfyUI/Gradio. Có thể thay bằng worker khác nếu tuân thủ hợp đồng bên dưới.

Tại thư mục StoryFlow, tạo môi trường Python riêng (khuyến nghị Python 3.11), cài PyTorch CUDA phù hợp GPU theo [PyTorch](https://pytorch.org/get-started/locally/), rồi:

```powershell
python -m venv .ai-venv
.\.ai-venv\Scripts\Activate.ps1
python -m pip install -r workers/requirements.txt
python -m pip install git+https://github.com/huggingface/diffusers.git
python workers/local_ai.py --engine flux
```

Worker lắng nghe `127.0.0.1:7861`, nạp model khi yêu cầu đầu tiên đến. Nó dùng `Flux2KleinPipeline` với checkpoint `black-forest-labs/FLUX.2-klein-4B`. Cần tải weights lần đầu, có thể cần đăng nhập Hugging Face nếu tài khoản bị yêu cầu. Worker này yêu cầu CUDA, có CPU offload; không hứa chạy trên máy không có GPU phù hợp. Nếu thiếu thư viện, model hoặc VRAM, yêu cầu báo lỗi chứ không trả ảnh giả.

Trong app: **Ảnh AI / Tạo video → Tạo ảnh: Bật → Engine ảnh: FLUX.2 local**. Chọn phong cách, chia lại cảnh nếu muốn áp dụng prompt mới, rồi tạo ảnh từng cảnh hoặc cả chương. Tắt tạo ảnh không xóa ảnh cũ; dùng ảnh có sẵn hoặc tải ảnh lên để render.

FLUX.2 **dev** có thể bị giới hạn sử dụng thương mại; không tự đổi checkpoint sang dev. Mặc định **klein-4B** có weights Apache-2.0 theo [model card chính thức](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B). Kiểm tra license cụ thể trước khi thay model.

## Wan2.2 — chỉ bật khi cần cảnh động

Wan nặng; nên tạo vài cảnh trước, không bật toàn truyện ngay. Adapter sử dụng chương trình image-to-video chính thức của Wan, không dùng ảnh lặp để giả kết quả model.

1. Cài repo và dependencies theo [Wan2.2](https://github.com/Wan-Video/Wan2.2) trong môi trường Python có CUDA. Với Windows, dùng môi trường được repo hỗ trợ (WSL nếu dependencies CUDA không cài native được).
2. Tải checkpoint **Wan-AI/Wan2.2-TI2V-5B** theo hướng dẫn repo. Không dùng checkpoint Diffusers với CLI gốc.
3. Cài `fastapi`, `uvicorn`, `pillow` trong cùng môi trường Wan. Mở terminal đó, cấu hình đường dẫn thực:

```powershell
$env:WAN22_REPO_DIR="D:/AI/Wan2.2"
$env:WAN22_CHECKPOINT_DIR="D:/AI/models/Wan2.2-TI2V-5B"
python workers/local_ai.py --engine wan
```

Chạy lệnh cuối từ thư mục StoryFlow (hoặc dùng đường dẫn tuyệt đối tới script). Hai biến trên phải có trong terminal worker Python, không chỉ trong `.env.local` của Next.js. Worker lắng nghe `127.0.0.1:7862`; chạy CLI với `--task ti2v-5B`, ảnh cảnh, prompt, CPU offload và đường dẫn MP4 tạm bằng mảng đối số, không qua shell. FLUX và Wan nên chạy lần lượt nếu GPU không đủ bộ nhớ.

Trong app:

- **Tắt** (mặc định): không gửi cảnh tới Wan, FFmpeg dùng ảnh tĩnh dù đã có clip cũ.
- **Chỉ cảnh đã chọn**: đánh dấu checkbox tại từng cảnh rồi tạo ảnh động. Cảnh không chọn vẫn dùng ảnh tĩnh.
- **Toàn bộ cảnh**: nút tạo hàng loạt áp dụng cho chương đang mở. Không tự tạo clip chỉ vì đổi lựa chọn.

Cảnh cần ảnh thật trước khi gửi Wan. Clip ngắn được lặp/cắt theo độ dài lời đọc khi dựng; chỉ lấy luồng hình của clip và dùng audio TTS của cảnh. Cảnh chưa có clip hợp lệ vẫn dùng ảnh tĩnh, kèm trạng thái chưa tạo/lỗi. Tạo lại ảnh sẽ gỡ clip cũ để tránh lệch nội dung. Tạo lại giọng không bắt buộc tạo lại ảnh hay clip.

## API, trạng thái và file

- `POST /api/tts/preview`, `/api/tts/generate`: như tài liệu TTS; `audioUrl` trỏ tới `/generated/audio/...`.
- `POST /api/image/generate`: `{prompt,provider:"flux2-local",enabled:true,aspect:"16:9",style:"Tu tiên"}` → `{ok:true,file,imageUrl}` sau khi giải mã và lưu PNG thật. `enabled:false` báo tạo ảnh đang tắt, không gọi worker. Nếu gửi `{projectId,chapterIds,sceneIds?,merge:true}` thì tạo job ảnh theo thiết lập dự án đã lưu.
- `POST /api/video/generate`: `{projectId,chapterIds,sceneIds?,merge:true}` → `{ok:true,jobId,jobs}`. Cần lưu chế độ ảnh động và checkbox trước. Không có cảnh được chọn hoặc chế độ tắt thì báo lỗi.
- `GET /api/video/jobs/<jobId>`: trạng thái job, lỗi, trạng thái từng cảnh, `videoUrl` chỉ khi có MP4 đã xác minh. `ready` nghĩa là tài nguyên đã lưu, không phải video YouTube cuối cùng.
- Worker Python `POST /generate`: FLUX nhận `{model,prompt,aspect}`, trả binary PNG. Wan nhận thêm `image_base64`, trả binary MP4. `/health` chỉ báo service chạy, không khẳng định model đã nạp. Worker không nhận URL ảnh hay đường dẫn file từ trình duyệt.

Audio mới nằm ở `public/generated/audio`, ảnh mới ở `public/generated/images`, clip mới ở `public/generated/motion`. Giữ bản trong `data/assets` để tương thích đường dẫn render/download cũ. Các file tồn tại qua refresh/khởi động lại; không xóa hai thư mục nếu muốn giữ tài nguyên. File cũ không tự di chuyển. API chỉ báo thành công sau khi kiểm tra ảnh giải mã được hoặc ffprobe thấy luồng hình và thời lượng dương. Không có phần trăm suy luận giả; hàng đợi cập nhật sau mỗi cảnh.

App và worker cần cùng thư mục dữ liệu. Giữ ứng dụng ở localhost; file dưới `public/generated` là tài nguyên có thể truy cập qua URL. Không tự tải/cài model GPU khi khởi động app.

## Kiểm tra lần nâng cấp này

- `npm test`: 15 kiểm tra qua, gồm chọn cảnh động, engine local, tên Ngọc Huyền và lỗi thiếu VieNeu.
- `npm run build`: qua. Python worker qua kiểm tra cú pháp.
- Bản production `npm start`: WAV tạo sau lúc server khởi động tải được (HTTP 200), đọc từng phần để tua được (HTTP 206). Route `app/generated/[kind]/[name]/route.ts` phục vụ file mới trên đĩa thay vì phụ thuộc danh sách public file lúc khởi động Next.js.
- Kiểm tra Edge/API: VieNeu đang chạy và trả WAV thật; FLUX/Wan chưa chạy thì trả lỗi tiếng Việt, không có file thành công giả; không lỗi JavaScript.
- Chỉ cảnh được chọn có tác vụ Wan. Tắt tạo ảnh bỏ qua FLUX trong bước chuẩn bị. Sau lỗi Wan, tắt ảnh động vẫn render MP4 từ ảnh tải lên và TTS thật thành công; FFprobe xác minh MP4.
- Chưa chạy suy luận FLUX.2 hoặc Wan2.2 thật trên GPU trong lần này; cần cài dependencies, model và chạy worker theo hướng dẫn. Không khẳng định chất lượng/thời gian suy luận khi chưa thử trên GPU của bạn.
- Script kiểm tra: `node scripts/verify-local-ai.mjs` (cần app, worker và Korva đã cấu hình; giả định FLUX/Wan chưa chạy). Dự án thử tạm được xóa sau khi kiểm tra; truyện người dùng được giữ nguyên.

File chính: `modules/providers/local-workers.ts`, `modules/imagePrompt/index.ts`, `modules/videoRender/index.ts`, `modules/tts/*`, `scripts/worker.ts`, `app/page.tsx`, các route mới trong `app/api/image`, `app/api/video`, `app/generated`, schema/types/media dự án, `workers/local_ai.py`, `.env.example` và tài liệu này. Bộ tách chương không thay đổi.
