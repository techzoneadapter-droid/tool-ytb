import { Youtube, Facebook, Link2 } from "lucide-react";
export function ChannelManagerPage() {
  return (
    <>
      <header className="page-header">
        <span className="eyebrow">KẾT NỐI KHÁN GIẢ</span>
        <h1>Quản lý kênh</h1>
        <p>Một nơi cho những câu chuyện bạn muốn chia sẻ.</p>
      </header>
      <div className="channel-grid">
        {[
          {
            name: "YouTube",
            Icon: Youtube,
            desc: "Quản lý kênh YouTube và đăng video trực tiếp.",
            features: "Liên kết kênh · Video & thumbnail · Lịch đăng",
          },
          {
            name: "Facebook",
            Icon: Facebook,
            desc: "Quản lý Facebook Page và đăng Reel, video.",
            features: "Liên kết Page · Caption · Lịch đăng",
          },
        ].map(({ name, Icon, desc, features }) => (
          <section className="card channel-card" key={name}>
            <span className={"channel-logo " + name.toLowerCase()}>
              <Icon size={34} />
            </span>
            <span className="badge">Đang phát triển</span>
            <h2>{name}</h2>
            <p>{desc}</p>
            <p className="muted">{features}</p>
            <button disabled>
              <Link2 size={17} />
              Liên kết {name}
              <span>Sắp có</span>
            </button>
          </section>
        ))}
      </div>
    </>
  );
}
