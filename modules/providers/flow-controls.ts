import type { Locator, Page } from "playwright";

async function clickVisible(locator: Locator) {
  const target = locator.filter({ visible: true }).first();
  if (!(await target.count())) return false;
  await target.click();
  return true;
}

/** Standard Flow composer: model menu -> Image -> model/aspect/output count.
 * See https://support.google.com/flow/answer/16729550 . */
export async function configureFlowImages(
  page: Page,
  model: string,
  aspect: "16:9" | "9:16",
) {
  const agent = page.getByRole("switch", { name: /^agent$/i }).filter({ visible: true }).first();
  if ((await agent.count()) && (await agent.isChecked())) await agent.uncheck();
  const agentButton = page.getByRole("button", { name: /^(agent|tác nhân)$/i }).filter({ visible: true }).first();
  if ((await agentButton.count()) && (await agentButton.getAttribute("aria-pressed")) === "true")
    await agentButton.click();
  const picker = page
    .getByRole("button", {
      name: /nano banana|imagen|veo|text to video|frames to video|ingredients to video/i,
    })
    .or(page.getByRole("combobox", { name: /nano banana|imagen|veo/i }))
    .or(page.locator("button.settings-trigger-button"))
    .or(page.getByRole("button", { name: "Điều kiện kích hoạt cài đặt", exact: true }));
  if (!(await clickVisible(picker)))
    throw Error(
      "Không tìm thấy bộ chọn model Flow. Mở dự án và tắt Agent để dùng ô tạo ảnh tiêu chuẩn.",
    );

  const imageMode = /^(image|images|create images|tạo ảnh|hình ảnh|ảnh)$/i;
  const mode = page
    .getByRole("tab", { name: imageMode })
    .or(page.getByRole("button", { name: imageMode }))
    .or(page.getByRole("menuitem", { name: imageMode }));
  if (!(await clickVisible(mode)))
    throw Error(
      "Không tìm thấy chế độ Image trong menu Flow. Chưa gửi prompt để tránh tạo nhầm video.",
    );

  const requested = page
    .getByText(new RegExp(`^(?:🍌\\s*)?${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))
    .filter({ visible: true })
    .last();
  if (!(await requested.count())) {
    await clickVisible(
      page
        .getByRole("combobox")
        .filter({ hasText: /nano banana|imagen/i })
        .or(page.getByRole("button", { name: /nano banana|imagen/i })),
    );
  }
  if (!(await clickVisible(requested)))
    throw Error(
      `Tài khoản Flow không hiển thị model ${model}. Kiểm tra model trong cửa sổ đăng nhập.`,
    );

  const ratio = new RegExp(aspect.replace(":", "\\s*:\\s*") + (aspect === "16:9" ? "|crop_16_9|ngang|landscape" : "|crop_9_16|dọc|portrait"), "i");
  const ratioOptions = () =>
    page
      .getByRole("button", { name: ratio })
      .or(page.getByRole("radio", { name: ratio }))
      .or(page.getByRole("option", { name: ratio }))
      .or(page.getByRole("menuitem", { name: ratio }));
  if (!(await clickVisible(ratioOptions()))) {
    // Some versions close the preferences popover after choosing a model.
    if (!(await ratioOptions().filter({ visible: true }).count()))
      await clickVisible(picker);
    await clickVisible(
      page
        .getByRole("combobox")
        .filter({ hasText: /16:9|9:16|1:1|landscape|portrait/i })
        .or(
          page.getByRole("button", {
            name: /16:9|9:16|1:1|landscape|portrait/i,
          }),
        ),
    );
    if (!(await clickVisible(ratioOptions())))
      throw Error(`Không chọn được tỷ lệ ${aspect} trong Flow.`);
  }
  // Prefer one output to avoid spending credits on unused variations.
  await clickVisible(
    page
      .getByRole("button", { name: /^(x1|1x|1)$/i })
      .or(page.getByRole("radio", { name: /^(x1|1x|1)$/i })),
  );
  await page.keyboard.press("Escape");
}
