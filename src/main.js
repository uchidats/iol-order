import { loadConfig } from "./config.js";
import { createStaticRepository, DEFAULT_FACILITY_ID } from "./data/static-repository.js";
import { initOrderForm } from "./ui/order-form.js";
import { initBiometry } from "./biometry/biometry-ui.js";

async function bootstrap() {
  const config = await loadConfig();
  const repository = createStaticRepository();

  await initOrderForm({ config, repository, facilityId: DEFAULT_FACILITY_ID });
  initBiometry();
}

bootstrap().catch(err => {
  console.error("初期化に失敗しました:", err);
});
