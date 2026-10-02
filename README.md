# StoryFlow — dựng video từ tài nguyên thật

Next.js + TypeScript, SQLite, FFmpeg. Không tự tạo dự án mẫu; không có nhánh tạo giọng im lặng hay ảnh màu giả lập. Chức năng tách chương được giữ nguyên.

## Chạy

Cần Node.js 22.13+ (khuyên dùng 24), FFmpeg và ffprobe trên PATH, FFmpeg có libx264/libass.

```sh
npm install
npm run dev
# Terminal thứ hai:
npm run worker
```

Mở http://127.0.0.1:3000. Chạy bản tối ưu: `npm run build`, `npm start` và `npm run worker`. Chỉ chạy một worker. Mặc định ứng dụng chỉ lắng nghe localhost, chưa có đăng nhập; không triển khai nguyên trạng ra Internet.

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

## Luồng sử dụng

1. Nhập truyện hoặc chọn dự án đang có. Không thay đổi bộ tách chương.
2. Vào **Giọng đọc**, chọn engine local hoặc giọng API đã cấu hình. **Nghe thử** tạo file thật, hiển thị trình phát và nút tải MP3 sau khi ffprobe xác nhận thời lượng > 0. Local không tính phí API; nhóm đám mây có thể tính phí.
3. Chọn giọng, tốc độ, cao độ, âm lượng, lưu. Thay đổi thông số lời đọc sẽ bỏ liên kết audio cũ trong dự án để tránh dùng nhầm giọng khi render.
4. Chọn phong cách ảnh; **Chia lại cảnh theo phong cách** thêm prompt hệ thống riêng vào mô tả từng cảnh. Có 10 preset: Tu tiên/Tiên hiệp, Huyền huyễn, Võ hiệp cổ trang, Cổ trang Trung Hoa, Anime, Manhua, Dark fantasy, Điện ảnh chân thực, Hoạt hình 2.5D, Chibi.
5. **Tạo lời đọc cảnh này** / **Tạo ảnh cảnh này**, hoặc tạo cho toàn chương. Các tác vụ chạy tuần tự qua worker, lưu trạng thái và lỗi trên từng cảnh. Tạo lại thay thế liên kết sau khi nhận tệp hợp lệ. Ảnh thật được giải mã, cắt về 1280×720 hoặc 720×1280. Có thể tải ảnh lên thay cho API.
6. Nghe audio, xem ảnh, duyệt cảnh. Chỉ xuất video khi mỗi cảnh có ảnh và lời đọc thật còn tồn tại trên đĩa, bất kể có bật duyệt trước hay không.
7. **Xuất video** ghép theo thứ tự chương trong dự án. FFmpeg xuất MP4 với audio và phụ đề. Phần trăm mã hóa lấy từ `-progress` / thời gian đầu ra của FFmpeg; các công đoạn chiếm các khoảng phần trăm, không phải đồng hồ đếm giả. Lỗi có log FFmpeg.
8. Trước khi ghi “Hoàn tất / 100%”, worker kiểm tra file tồn tại và ffprobe thấy luồng video, audio, thời lượng > 0. Trang Xuất video có trình phát, toàn màn hình, tải MP4/SRT/VTT; MP3 tải ở từng cảnh. Tác vụ tạo tài nguyên hiển thị “Tài nguyên đã lưu”, không giả là video hoàn tất.
9. Tải lại trang vẫn giữ dự án, tài nguyên và video. Nếu file bị xóa khỏi máy, API không tiếp tục trả trạng thái thành công cho file đó.

Nghe thử không dùng giọng tổng hợp của trình duyệt. Khi thiếu engine local hoặc khóa API, ứng dụng báo lỗi cụ thể; không trả tệp giả và không tạo tác vụ hoàn tất.

## Lưu trữ, phạm vi

- SQLite `data/storyflow.sqlite`, file `data/assets`, trung gian `data/work`; sao lưu cả thư mục.
- Chỉ một worker, tạm dừng ở công đoạn hiện tại hoặc lần cập nhật FFmpeg kế tiếp. Nếu dừng cưỡng bức, xác nhận PID trong `data/worker.lock` không chạy rồi xóa lock. Khởi động lại sẽ phục hồi tác vụ dang dở; gọi lại dịch vụ có thể phát sinh phí.
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

Kiểm tra TTS local ngày 02/10/2026: KorvaTTS 0.1.3 trong `.tts-venv` đã tạo WAV/MP3 thật, trình duyệt nhận thời lượng dương, tải được file sau refresh; worker tạo audio cảnh bằng `korva-local`, cache trả cùng nội dung file. VieNeu chưa được cài/chạy trên máy: đã kiểm tra thông báo thiếu engine, chưa kiểm thử tổng hợp VieNeu thật. Không gọi API đám mây trong kiểm tra local này.

Kiểm tra lại sau khi chạy server và worker: `node scripts/verify-local-tts.mjs --audio`, `node scripts/verify-local-pipeline.mjs`. Cần Edge và Korva đã cấu hình; script pipeline chỉ tạo rồi xóa dự án kiểm thử riêng, không sửa truyện có sẵn.

## Các module

`modules/providers/config.ts`: cấu hình và trạng thái không chứa khóa; `modules/tts`: giọng và API TTS; `modules/imagePrompt`: prompt hệ thống và API ảnh; `modules/project/media.ts`: xác minh tài nguyên; `modules/videoRender`: FFmpeg; `scripts/worker.ts`: hàng đợi; `app/api/tts/preview`: nghe thử; `app/api/studio`: thao tác dự án/cảnh/tác vụ.
