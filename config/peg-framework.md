# PEG 估值框架（v9 — 2026 年 7 月校準）

> 此檔由 `scripts/peg-review.mjs` 每月讀入，注入到 LLM prompt。
> 若分析共識升級到 v10，**直接編輯這個檔即可**，不用改 code。
> peg-review 仍會保留 ±0.3 monthly change cap 與 confidence ≥0.7 安全閥。

## 1. 五因子評分方法論（v9：AI 感知—行動基礎設施供應鏈研究）

每家候選公司在以下五因子各打 1-10 分，加權後得到總分；總分越高 PEG 越高。

| # | 因子 | 權重 | 觀察點 |
|:-:|:--|:-:|:--|
| 1 | **Backlog 能見度** | **25%** | 公司 backlog $額 / 年營收倍數；管理層 visibility 至幾年 |
| 2 | **AI 收入集中度** | **20%** | AI 業務佔總營收 %；越純越高分 |
| 3 | **Operating leverage / 邊際擴張** | **20%** | OPM 走勢、 EPS revision 加速度 |
| 4 | **供應鏈瓶頸位置** | **20%** | 是否處於不可繞過的卡脖子點（CUDA / CoWoS / HBM / GOES 鋼） |
| 5 | **盈利上修動能** | **15%** | 過去 3 個月分析師 EPS 上修方向 + 公司 guidance raise 頻率 |

**重要**：pricing power **不單獨列為因子**，因為它已內建在「margin trajectory + bottleneck position」兩項。重複計算會雙重加權。

v9 新增判斷：不要把所有 AI 零組件都當成鏟子。能保留利潤的節點通常具備至少一項特徵：供給難以快速擴張、認證週期長、掌握標準／整合權，或每個 endpoint 都必須配置。模型能力平價化會擴大 AI 使用量，但也會壓縮閉源模型/API 租值；因此 PEG 應更偏向 HBM、先進封裝、scale-up/scale-out 互連、光學、配電冷卻、可信資料與高 attach-rate endpoint 元件。

---

## 2. 分類 PEG 參考區間（依五因子總分映射）

| 五因子總分 | PEG 區間 | 對應分類 |
|:-:|:-:|:--|
| 9.5+ | 2.0 - 2.2 | AI 全棧霸主（NVIDIA 級別） |
| 8.5 - 9.5 | 1.7 - 2.0 | 結構性贏家（記憶體龍頭、晶圓代工、純 AI hyperscaler、純 AI infra） |
| 8.0 - 8.5 | 1.6 - 1.9 | 純度高的補位（Astera Labs、Vertiv、Vistra、Bloom 級別） |
| 7.0 - 8.0 | 1.4 - 1.7 | AI 挑戰者、二線贏家、ABF 載板、edge / IP 控制點 |
| 6.0 - 7.0 | 1.3 - 1.5 | AI 集中度中等的多元化公司、Marvell 級別 |
| 5.0 - 6.0 | 1.0 - 1.3 | 多元化攤薄的傳統巨頭、commodity miners |

---

## 3. 細項分類錨點（具體 ticker 對照）

### 3.1 AI 需求方 / 平台入口
- **NVIDIA** accelerator + network + robotics full stack：**2.0 - 2.2**。仍是最高控制點，但中國模型與國產 stack 分裂使壟斷溢價略降。
- **AAPL** 端側裝置 + Secure Enclave + AI glasses 選擇權：**1.1 - 1.3**。AI 供應鏈純度低，Wave 2 時程尚未完全驗證。
- **MSFT** OpenAI + Azure + Copilot + enterprise identity/device management：**1.7 - 1.9**。
- **GOOGL** Gemini + Cloud + TPU，但 search 有 AI 替代風險、capex 消化期壓 FCF：**1.5 - 1.7**。
- **META** Llama + hyperscaler demand + AI glasses / personal context 入口：**1.4 - 1.6**。Reality Labs 與 capex 稀釋供應鏈純度。

### 3.2 AI 晶片供應方
- **TSM** 製程獨占 + CoWoS 緊到 2027：**1.6 - 1.8**
- **AMD** 全棧抗 NVIDIA 但 share 第二：**1.6 - 1.8**
- **記憶體 (SK Hynix / MU / Samsung)**：**1.4 - 1.6**（cyclical 折扣，HBM 超循環抵銷）。v9 強調近期 HBM moat 仍在，但 CXMT/YMTC 與 2027-2028 供給過剩是中期風險。

### 3.3 AI 網路 / 客製矽
- **AVGO** AI infra +106% YoY + 客製 ASIC 年化 $100B：**1.6 - 1.8**
- **ALAB** 90% AI server 用其產品 + GM 76% 但 5 客戶集中度：**1.7 - 1.9**
- **MRVL** 客製 ASIC + CPO 但車用 Ethernet 已賣 Infineon：**1.4 - 1.6**

### 3.4 AI 基建 / 電力
- **VRT** backlog $12.45B + 600kW 機櫃直接受益：**1.7 - 1.9**
- **BE** backlog $20B（10× 年營收） + Q1 +130%：**1.7 - 1.9**
- **VST** Meta 2,600 MW PPA 未含 guidance + IPP 屬性：**1.5 - 1.7**
- **GEV** $163B backlog 但 Wind EBIT -$400M 拖累：**1.5 - 1.7**
- **ETN** quality compounder 但 AI 不夠純：**1.5 - 1.7**
- **NXT.AX** 澳洲 data center 純玩家：**1.4 - 1.6**。通電 MW、融資成本與 pre-profit 狀態比 announced MW 更重要。
- **MAQ.AX** 澳洲 data center + telco + cyber diversified：**1.3 - 1.5**。AI infra exposure 明確但規模小、純度低於 NEXTDC。

### 3.5 Physical AI 純玩家
- **HSAI** LiDAR 龍頭 + Mercedes L3 + Morgan Stanley humanoid 唯一 LiDAR：**1.6 - 1.8**（China ADR 折扣）
- 機器人零組件（Harmonic Drive, Nidec, Proterial）：**1.4 - 1.7**

### 3.6 上游礦產
- **FCX** 銅龍頭（AI DC 33-50 萬噸 / 年需求 2030）：**1.5 - 1.7**
- **MP** 美國本土唯一稀土：**1.7 - 1.9**
- **BHP / RIO** 多元化礦業 diversified discount：**1.2 - 1.4**

---

## 4. 重要 heuristics（PEG 調整規則）

1. **成長預估下修 >3pp** → PEG -0.1 ~ -0.2
2. **成長預估上修 >3pp** → PEG +0.1 ~ +0.2
3. **EPS + FCF 連續多月上修** → quality momentum，PEG +0.1
4. **Beta 大幅上升 >0.20** → 風險加大，PEG -0.1 ~ -0.2
5. **20%+ EPS CAGR 多年管理層公開承諾** → +0.1 ~ +0.2 premium
6. **客戶集中度 >80%（如 ALAB 5 客戶=90%）** → -0.1 discount
7. **China ADR / 中國本土公司** → -0.1 ~ -0.2 折扣（地緣風險）
8. **Wind / 非 AI 業務拖累 EBIT 為負** → -0.1 ~ -0.2（如 GEV）
9. **Pre-profit（TTM EPS 接近零）** → 維持當前 PEG，不要因短期數字波動而搖擺
10. **Commodity / cyclical** → PEG cap ≤ 1.5（除非有結構性供給赤字，如銅、稀土）

---

## 5. 2026 必須監控的風險事件

| 事件 | 影響 PEG 方向 |
|---|---|
| **2026-11-27** 中國礦產管制截止日（鎵 / 鍺 / 鎢 / 銻） | 若管制重啟：非中稀土／材料玩家 PEG ↑；CPO/光通訊 (MRVL, AVGO) PEG ↓ |
| HBM 2027-2028 過剩風險（BofA 預測） | 記憶體 (MU, SK Hynix) PEG ↓ |
| Tesla Optimus 量產進度（Musk Q1 26：「impossible to predict」） | 機器人鏈 (HSAI, Harmonic) — 量產延後則 PEG ↓ |
| 美國電網變壓器 5 年交期 + 50% 規劃 DC 可能延後 | AI 電力／配電／冷卻玩家 (BE, VRT, GEV, ETN) backlog 越強 PEG 越能維持 |
| 客製 ASIC 對 NVIDIA 侵蝕加速 | NVIDIA PEG 緩慢下修；AVGO / MRVL PEG ↑ |
| Hyperscaler capex digestion | 高估值、單客戶、高 capex 供應商 PEG ↓；已簽約且 backlog 可驗證者較能維持 |
| Kimi K3 / 中國 open-weight 模型若證實可低成本部署 | 閉源 API 租值 ↓；多模型中立 infra、HBM、互連、edge endpoint attach rate ↑ |

---

## 6. 框架升級記錄

| 版本 | 日期 | 主要變化 |
|---|---|---|
| v4 | 2026-05 | 加入上游礦產層；Top 10 含 FCX |
| v6 | 2026-06 | 從四類粗框架升級為**五因子加權方法論**；Physical AI 純玩家獨立分類；ALAB / HSAI / MRVL 進入候選池；Tesla 從 #5 降到 #17（實事求是反映 Optimus 進度） |
| v9 | 2026-07 | 對齊《AI 感知—行動基礎設施供應鏈投資研究》：加入 Apple / Meta / Broadcom / SK Hynix，移除四檔舊標的；強化 4+4 框架、Kimi K3、中國衝擊、澳洲 data center thesis 與市值排序。 |

**下次升級**：當分析報告 v10 出來時，直接編輯本檔（更新分類、調整錨點區間、補新 ticker），peg-review.mjs 下次跑就會自動套用，不需要改任何 code。
