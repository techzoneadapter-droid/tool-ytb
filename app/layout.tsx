import "./globals.css";
export const metadata = {
  title: "StoryFlow · Xưởng video kể chuyện",
  description: "Từ câu chuyện đến thước phim của bạn.",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
