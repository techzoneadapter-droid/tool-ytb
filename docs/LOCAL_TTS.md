## Desktop: tự cài VieNeu sau cập nhật

Bản desktop tự thiết lập VieNeu khi mở dự án đã chọn `vieneu-local`: tải Python riêng, cài VieNeu 3.8.3 và tải/nạp model CPU ONNX int8. Không cần cài Git, Python, uv hay chạy PowerShell thủ công. Có nút **Cài và khởi động VieNeu** và nhật ký/tiến độ từng giai đoạn trong Tạo video. Lần đầu cần Internet và có thể mất nhiều phút; app chỉ báo sẵn sàng sau khi engine trả danh sách giọng thực tế.

Môi trường nằm trong `<thư mục dữ liệu>/data/ai/vieneu`, Python/uv riêng trong `data/ai/tools`, model trong `data/huggingface` (hoặc `HF_HOME` đã cấu hình). Cập nhật app giữ các thư mục này. Nếu cài đặt bị gián đoạn, bấm nút cài lại để tiếp tục, không xóa truyện. App chờ thiết lập xong trước khi cài bản cập nhật hoặc đổi thư mục dữ liệu.

Môi trường VieNeu bên ngoài qua `VIENEU_REPO_DIR` và repo cũ đã cài vẫn được ưu tiên khi có cấu hình. Cấu hình managed mặc định dùng CPU, không bắt buộc card NVIDIA; người dùng có môi trường GPU riêng vẫn dùng cấu hình cũ. VieNeu được cài từ PyPI; uv 0.12.24 tải từ bản phát hành chính thức, kiểm tra SHA256 trước khi chạy. Phần dưới là tài liệu thao tác thủ công/lịch sử cho bản mã nguồn.

# TTS local miễn phí cho StoryFlow

> Cập nhật workflow 02/10/2026: `npm run dev` (hoặc `npm run app`) và `npm start` tự khởi động worker. Không cần terminal thứ hai. Trang Tạo video chạy toàn bộ pipeline; tài liệu/lệnh thủ công bên dưới dùng để cài đặt hoặc chẩn đoán nâng cao. Korva giữ model trong `workers/korva_server.py`; VieNeu tự khởi động từ `VIENEU_REPO_DIR` (mặc định repo VieNeu-TTS cạnh StoryFlow). Nút **Khởi động AI Engine** không tự cài dependencies. Các kết quả cũ bên dưới là lịch sử, xem README cho kết quả mới nhất.


Chỉ sử dụng giọng dựng sẵn. VieNeu là engine mặc định của dự án mới; Korva là lựa chọn dự phòng **do người dùng chọn**, không tự đổi engine hoặc gọi API trả phí khi lỗi. Dự án cũ giữ giọng cloud cho đến khi đổi và lưu thiết lập.

## Cấu hình

Trên máy này đã cài KorvaTTS 0.1.3 vào `.tts-venv`, tải mô hình và đặt `KORVATTS_BIN` trong `.env.local`. Có thể nghe thử **Ngọc Huyền → KorvaTTS local** ngay khi app chạy. VieNeu vẫn cần cài/chạy theo hướng dẫn bên dưới. Khi chuyển dự án sang máy khác, cài lại môi trường và sửa đường dẫn `KORVATTS_BIN`; không sao chép nguyên đường dẫn tuyệt đối của máy này.

Thêm vào `.env.local` (giữ nguyên các biến đang có):

```dotenv
DEFAULT_TTS_PROVIDER=vieneu-local
DEFAULT_VIETNAMESE_VOICE=ngoc_huyen
VIENEU_LOCAL_URL=http://127.0.0.1:8000
KORVATTS_BIN=korvatts
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

`VIENEU_LOCAL_URL` chỉ nhận địa chỉ loopback. `KORVATTS_BIN` là tên lệnh hoặc đường dẫn đầy đủ tới `korvatts.exe`, không kèm đối số. Nếu dùng môi trường Python riêng, trỏ tới `<môi trường>/Scripts/korvatts.exe`. Khởi động lại cả `npm run dev` và `npm run worker` sau khi đổi biến. Không cần API key cho local. Giữ `TTS_PROVIDER=openai` hoặc `azure` cho nhóm API tùy chọn; biến này không ảnh hưởng lựa chọn local.

## KorvaTTS (Python 3.10 trở lên)

```powershell
python -m pip install --upgrade pip
python -m pip install korvatts
korvatts voices
korvatts synth "Xin chào, mình là Ngọc Huyền." -v ngoc_huyen -o test.wav
```

Korva chạy resident tại `127.0.0.1:7863`, giữ một model trong RAM. Service dùng model đã có trong `KORVATTS_ASSETS_DIR` hoặc cache Hugging Face, không tự tải weights. `/voices` gọi `TTS.list_voices()`; `/preview` dùng 12 steps, `/synthesize` dùng 32 steps. CLI ở trên chỉ dùng chẩn đoán.

Giọng: Ngọc Huyền, Bảo Kim, Khánh Vy, Phương Linh, Quỳnh Như, Gia Bảo, Hoàng Nam, Hữu Đạt, Quang Huy và Thanh Phong.

## VieNeu-TTS v3 Turbo

Trên máy hiện tại, mở terminal riêng và giữ tiến trình chạy:

```powershell
cd "D:\Desktop\tool\VieNeu-TTS"
python -m uv run python -m apps.openai_speech
```

Cài Git và uv nếu chưa có (`python -m pip install uv`), rồi mở terminal riêng:

```powershell
git clone https://github.com/pnnbao97/VieNeu-TTS.git
cd VieNeu-TTS
uv sync
uv run python -m apps.openai_speech
```

Lệnh trên dành cho chạy thủ công. Trong app, nút Khởi động mở service nền một lần. Kiểm tra `http://127.0.0.1:8000/health` và `/v1/voices`. StoryFlow hiển thị toàn bộ danh sách engine trả về (25 giọng trên máy này), nhận ID/name/aliases và gửi đúng ID. Trạng thái được lưu đệm 15 giây.

Adapter gửi `model: vieneu-v3-turbo`, `voice: <ID được chọn>`, `response_format: wav` đến `/v1/audio/speech`. WAV streaming được chuẩn hóa bằng FFmpeg trước khi đo thời lượng. Tốc độ, cao độ, âm lượng và nghỉ cuối cảnh được áp dụng trên máy; audio cuối có thể xuất WAV hoặc MP3.

## Nghe thử và tạo audio

1. Chạy `npm run dev`; terminal khác chạy `npm run worker`.
2. Vào **Giọng đọc → Local miễn phí**, tìm Ngọc Huyền với nhãn VieNeu-TTS local hoặc KorvaTTS local.
3. Bấm **Nghe thử**. Chờ audio thật xuất hiện, nghe bằng trình phát và tải MP3 nếu cần.
4. Bấm **Chọn giọng**, lưu thiết lập dự án, rồi tạo lời đọc cảnh/chương trong luồng hiện có.

Nếu thiếu engine, API trả `ok: false` và thông báo tiếng Việt; không tạo audio im lặng hoặc báo hoàn tất giả. Vietnamese TTS Studio chỉ là mục “Clone giọng local - đang phát triển”, không có endpoint clone. Chỉ sử dụng file mẫu để clone khi có quyền sử dụng giọng.

## API và lưu trữ

POST `/api/tts/preview` hoặc `/api/tts/generate`, cùng origin với app:

```json
{"provider":"vieneu-local","voiceId":"ngoc_huyen","text":"Xin chào, mình là Ngọc Huyền.","format":"wav","speed":1}
```

Thành công trả `{ok:true,audioUrl,provider,voiceId,file,duration,cached}`. Lỗi trả HTTP 400; origin không hợp lệ trả 403. Preview luôn đọc câu 9 từ cố định, xuất MP3 và bỏ qua text/pitch/volume từ client. Cache preview theo engine/voice/speed, giữ qua restart; bấm lại trong browser phát ngay không gọi API. Generate nhận tối đa 20.000 ký tự, xuất WAV hoặc MP3.

File lưu tại `data/assets`, truy cập bằng `/api/files/<tên an toàn>`. Cache dùng hash nội dung, engine, giọng, định dạng và thông số đọc; file phải đo được thời lượng dương mới tái sử dụng. Đổi văn bản/giọng/thông số sẽ tạo cache khác. Không xóa `data` nếu muốn giữ dự án và audio qua lần khởi động sau. Cache không tự hết hạn; có thể xóa các file cache không còn cần thiết khi ứng dụng và worker đã dừng.

## Giấy phép và nguồn

- [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) và [model card v3 Turbo](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo): phiên bản tích hợp là v3 Turbo, model card công bố Apache-2.0. Không thay bằng checkpoint phi thương mại hoặc model khác chỉ vì cùng API.
- [KorvaTTS](https://github.com/dogenthq/KorvaTTS): repo công bố Apache-2.0 cho cả code và weights; giữ LICENSE/NOTICE khi phân phối.
- [Vietnamese TTS Studio](https://github.com/vuhai2002/vietnamese-tts-studio): chỉ đặt chỗ, chưa cài hoặc tích hợp clone.

## Kết quả kiểm tra trên máy này — 02/10/2026

- `npm test`: 12/12 qua. Không có script `lint` trong package.json.
- `npm run build`: qua, gồm hai route `/api/tts/preview` và `/api/tts/generate`.
- `npm run dev`: đang chạy ở `http://127.0.0.1:3000`; worker cũng đã khởi động.
- Edge: 11 thẻ local, không lỗi JavaScript; thiếu VieNeu trả lỗi rõ và không sinh player giả.
- Ngọc Huyền/Korva: MP3 nghe thử 7,059 giây, trình phát bắt đầu chạy, tải được 28.748 byte và file còn sau refresh.
- UI lưu provider/voice; worker tạo MP3 cảnh 3,644 giây, `audioSource=korva-local`. Generate WAV 1,765 giây; hai yêu cầu giống nhau trả cùng hash audio nhờ cache.
- Chưa cài/chạy VieNeu nên chưa xác minh tổng hợp thật của engine này. Không thử cloud có phí hoặc clone giọng.
- Dự án kiểm thử tạm đã được xóa. Truyện có sẵn vẫn giữ 51 chương, 76 cảnh; không còn job kiểm thử.

Các file thay đổi/thêm:

- `modules/tts/{index,cloud,local,local-voices,http}.ts`: điều phối, adapter local, giữ adapter cloud, cache và xử lý HTTP.
- `modules/providers/config.ts`, `modules/project/{types,validation}.ts`: trạng thái engine và lựa chọn TTS riêng.
- `app/api/tts/{preview,generate}/route.ts`, `app/api/studio/route.ts`, `scripts/worker.ts`: API và hàng đợi dùng lựa chọn TTS đã lưu.
- `app/page.tsx`: nhóm giọng local, nghe thử, trạng thái và lưu giọng; giữ bố cục hiện có.
- `tests/core.test.ts`, `scripts/verify-local-tts.mjs`, `scripts/verify-local-pipeline.mjs`: kiểm tra tự động và luồng thật.
- `.env.example`, `.gitignore`, `README.md`, `docs/LOCAL_TTS.md`: cấu hình và hướng dẫn. `.env.local` chứa cấu hình local của máy này, không đưa vào Git; `.tts-venv` và mô hình trong `data/huggingface` cũng không đưa vào Git.
