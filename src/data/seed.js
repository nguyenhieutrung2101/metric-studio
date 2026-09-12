import { createMetric, MetricStatus, MetricRole } from '../core/models/metric.js';
import { createBinding, BindingType } from '../core/models/binding.js';
import { createStructureNode, createMetricStructure } from '../core/models/structure.js';
import { createDimension, createDimensionMember, createMetricDimension } from '../core/models/dimension.js';
import { defaultScenarios, SCENARIO_TT_ID, SCENARIO_GD_ID } from '../core/models/scenario.js';
import { createUnit } from '../core/models/unit.js';
import { Store } from '../core/store/store.js';
import { createSelectors } from '../core/store/selectors.js';
import { resolveFormula } from '../services/binding-service.js';
import { padNumber } from '../utils/text.js';

const T = '2026-01-15T08:00:00.000Z';
const stamp = (rec) => ({ ...rec, createdAt: T, updatedAt: T, version: 1 });

/**
 * Demo catalogue. Deterministic ids so tests, docs and exported JSON stay
 * readable. Demonstrates:
 *   - shared TT/GD metric (Revenue, AOV, Occupancy)
 *   - TT-only metrics (Customer complaints, Vehicle utilisation)
 *   - GD-only growth assumption
 *   - non-bound draft / deprecated / unplaced metrics
 *   - structural hierarchy with folder-only nodes
 *   - dimensions with member hierarchies
 *   - formula dependencies and an explicit cross-scenario dependency
 *   - one intentionally missing reference ([DAYS_IN_PERIOD]) so the warning
 *     center has something real to show
 */
export function buildDemoSnapshot() {
  const units = [
    ['u-vnd', 'VND', 'Đồng Việt Nam'],
    ['u-pct', '%', 'Phần trăm'],
    ['u-count', 'count', 'Số lượng / lượt'],
    ['u-trip', 'trip', 'Chuyến'],
    ['u-vehicle', 'vehicle', 'Xe'],
    ['u-person', 'person', 'Người'],
    ['u-room-night', 'room-night', 'Đêm phòng'],
    ['u-room', 'room', 'Phòng'],
    ['u-ratio', 'ratio', 'Tỷ lệ (x)'],
    ['u-kg', 'kg', 'Kilogram'],
  ].map(([id, code, name]) => stamp(createUnit({ id, code, name })));

  const scenarios = defaultScenarios().map(stamp);

  // ------------------------------------------------------------ structure
  const nodes = [];
  const node = (id, parentId, code, name, sortOrder, owner = '') => {
    nodes.push(stamp(createStructureNode({ id, parentId, code, name, sortOrder, owner })));
    return id;
  };
  node('s-vh', null, 'VH', 'Vận hành', 1, 'Khối Vận hành');
  node('s-vh-dv', 's-vh', 'VH.DV', 'Vận hành dịch vụ', 1);
  node('s-vh-dv-cl', 's-vh-dv', 'VH.DV.CL', 'Chất lượng dịch vụ', 1, 'Phòng CSKH');
  node('s-vh-dv-tx', 's-vh-dv', 'VH.DV.TX', 'Quản lý tài xế', 2, 'Phòng Tài xế');
  node('s-vh-dv-ft', 's-vh-dv', 'VH.DV.FT', 'Fintech', 3, 'Ban Fintech');
  node('s-vh-dx', 's-vh', 'VH.DX', 'Đội xe', 2, 'Phòng Đội xe');
  node('s-kd', null, 'KD', 'Kinh doanh', 2, 'Khối Kinh doanh');
  node('s-kd-dt', 's-kd', 'KD.DT', 'Doanh thu', 1);
  node('s-kd-kh', 's-kd', 'KD.KH', 'Khách hàng', 2);
  node('s-tc', null, 'TC', 'Tài chính', 3, 'Khối Tài chính');
  node('s-ks', null, 'KS', 'Khách sạn', 4, 'Khối Khách sạn');
  node('s-ks-cs', 's-ks', 'KS.CS', 'Công suất & buồng phòng', 1);
  node('s-gd', null, 'GD', 'Giả định kế hoạch', 5, 'Ban Kế hoạch');

  // ------------------------------------------------------------ metrics
  const metrics = [];
  const placements = [];
  let seq = 0;
  const metric = (id, name, { aliases = [], unit, definition = '', status = MetricStatus.APPROVED, role = MetricRole.METRIC, owner = '', nodes: placeIn = [], code = null, tags = [] } = {}) => {
    seq += 1;
    metrics.push(stamp(createMetric({ id, code: code || `M.${padNumber(seq, 6)}`, name, aliases, definition, unitId: unit || null, status, role, owner, tags })));
    placeIn.forEach((nodeId, i) => placements.push(stamp(createMetricStructure({ id: `ms-${id}-${nodeId}`, metricId: id, structureNodeId: nodeId, isPrimary: i === 0, sortOrder: placements.length + 1 }))));
    return id;
  };

  metric('m-revenue', 'Doanh thu', { aliases: ['REVENUE', 'DT'], unit: 'u-vnd', role: MetricRole.KPI, owner: 'Trưởng phòng Doanh thu', nodes: ['s-kd-dt'], definition: 'Tổng doanh thu thuần từ dịch vụ vận chuyển và dịch vụ giá trị gia tăng trong kỳ, chưa bao gồm VAT. Ghi nhận theo thời điểm hoàn thành chuyến.' });
  metric('m-volume', 'Sản lượng chuyến', { aliases: ['VOLUME', 'SL'], unit: 'u-trip', owner: 'Phòng Vận hành', nodes: ['s-vh-dv', 's-kd-dt'], definition: 'Số chuyến hoàn thành trong kỳ (không tính chuyến huỷ).' });
  metric('m-price', 'Giá bình quân / chuyến', { aliases: ['PRICE'], unit: 'u-vnd', nodes: ['s-kd-dt'], definition: 'Doanh thu bình quân của một chuyến hoàn thành.' });
  metric('m-orders', 'Số đơn hàng', { aliases: ['ORDERS'], unit: 'u-count', nodes: ['s-kd-kh'], definition: 'Số đơn đặt dịch vụ được tạo trong kỳ.' });
  metric('m-active-customers', 'Khách hàng hoạt động', { aliases: ['ACTIVE_CUSTOMERS'], unit: 'u-person', role: MetricRole.KPI, nodes: ['s-kd-kh'], definition: 'Số khách hàng có ít nhất một đơn hoàn thành trong kỳ.' });
  metric('m-order-frequency', 'Tần suất đặt hàng / khách', { aliases: ['ORDER_FREQUENCY'], unit: 'u-ratio', nodes: ['s-kd-kh'], definition: 'Số đơn bình quân của một khách hàng hoạt động trong kỳ.' });
  metric('m-active-vehicles', 'Số xe hoạt động', { aliases: ['ACTIVE_VEHICLES'], unit: 'u-vehicle', owner: 'Phòng Đội xe', nodes: ['s-vh-dx'], definition: 'Số xe có ít nhất một chuyến hoàn thành trong kỳ.' });
  metric('m-aov', 'Giá trị đơn hàng bình quân (AOV)', { aliases: ['AOV'], unit: 'u-vnd', role: MetricRole.KPI, nodes: ['s-kd-dt'], definition: 'Doanh thu bình quân trên một đơn hàng. Cùng một chỉ tiêu tồn tại ở cả Thực tế (công thức) và Giả định (nhập trực tiếp).' });
  metric('m-trips-per-vehicle', 'Số chuyến / xe / ngày', { aliases: ['TRIPS_PER_VEHICLE'], unit: 'u-ratio', nodes: ['s-vh-dx'], definition: 'Năng suất khai thác bình quân của một xe.' });
  metric('m-trip-capacity', 'Công suất chuyến tối đa / xe / ngày', { aliases: ['TRIP_CAPACITY'], unit: 'u-ratio', nodes: ['s-vh-dx'], definition: 'Số chuyến tối đa một xe có thể phục vụ trong ngày theo SOP.' });
  metric('m-vehicle-utilization', 'Tỷ lệ sử dụng xe', { aliases: ['VEHICLE_UTILIZATION'], unit: 'u-pct', role: MetricRole.KPI, nodes: ['s-vh-dx'], definition: 'Mức khai thác thực tế so với công suất thiết kế. Chỉ theo dõi thực tế, chưa lập kế hoạch.' });
  metric('m-complaints', 'Số lượt phản ánh khách hàng', { aliases: ['COMPLAINTS'], unit: 'u-count', owner: 'Phòng CSKH', nodes: ['s-vh-dv-cl'], definition: 'Số phản ánh/khiếu nại ghi nhận qua mọi kênh trong kỳ.' });
  metric('m-complaint-rate', 'Tỷ lệ phản ánh / 1.000 chuyến', { aliases: ['COMPLAINT_RATE'], unit: 'u-ratio', role: MetricRole.KPI, nodes: ['s-vh-dv-cl'], definition: 'Số phản ánh trên mỗi 1.000 chuyến hoàn thành.' });
  metric('m-driver-headcount', 'Số tài xế', { aliases: ['HEADCOUNT_DRIVER', 'Headcount'], unit: 'u-person', owner: 'Phòng Tài xế', nodes: ['s-vh-dv-tx'], definition: 'Số tài xế đang hoạt động cuối kỳ.' });
  metric('m-drivers-per-vehicle', 'Tài xế / xe', { aliases: ['DRIVERS_PER_VEHICLE'], unit: 'u-ratio', nodes: ['s-vh-dv-tx'], definition: 'Hệ số tài xế bình quân trên một xe hoạt động.' });
  metric('m-wallet-users', 'Người dùng ví điện tử', { aliases: ['WALLET_USERS'], unit: 'u-person', nodes: ['s-vh-dv-ft'], definition: 'Số người dùng đã kích hoạt ví trong ứng dụng.' });
  metric('m-wallet-penetration', 'Tỷ lệ khách dùng ví', { aliases: ['WALLET_PENETRATION'], unit: 'u-pct', role: MetricRole.KPI, nodes: ['s-vh-dv-ft'], definition: 'Tỷ lệ khách hàng hoạt động có sử dụng ví điện tử.' });
  metric('m-opex', 'Chi phí vận hành', { aliases: ['OPEX'], unit: 'u-vnd', role: MetricRole.KPI, owner: 'Phòng Kế toán quản trị', nodes: ['s-tc'], definition: 'Tổng chi phí vận hành trong kỳ (nhiên liệu/điện, bảo dưỡng, nhân sự tài xế, vận hành ứng dụng).' });
  metric('m-margin', 'Biên lợi nhuận vận hành', { aliases: ['MARGIN'], unit: 'u-pct', role: MetricRole.KPI, nodes: ['s-tc'], definition: '(Doanh thu − Chi phí vận hành) / Doanh thu.' });
  metric('m-occupancy', 'Công suất phòng', { aliases: ['OCCUPANCY'], unit: 'u-pct', role: MetricRole.KPI, owner: 'Khối Khách sạn', nodes: ['s-ks-cs'], definition: 'Đêm phòng bán / Đêm phòng khả dụng.' });
  metric('m-room-nights-sold', 'Đêm phòng bán', { aliases: ['ROOM_NIGHTS_SOLD'], unit: 'u-room-night', nodes: ['s-ks-cs'], definition: 'Số đêm phòng đã bán trong kỳ.' });
  metric('m-room-nights-available', 'Đêm phòng khả dụng', { aliases: ['ROOM_NIGHTS_AVAILABLE'], unit: 'u-room-night', nodes: ['s-ks-cs'], definition: 'Số đêm phòng có thể bán trong kỳ.' });
  metric('m-rooms', 'Số phòng', { aliases: ['ROOMS'], unit: 'u-room', nodes: ['s-ks-cs'], definition: 'Tổng số phòng đưa vào khai thác.' });
  metric('m-growth-rate', 'Giả định tăng trưởng doanh thu', { aliases: ['GROWTH_RATE'], unit: 'u-pct', role: MetricRole.INDICATOR, owner: 'Ban Kế hoạch', nodes: ['s-gd'], definition: 'Tỷ lệ tăng trưởng doanh thu năm kế hoạch so với năm thực tế gần nhất. Chỉ tồn tại ở kịch bản Giả định.' });
  metric('m-cost-growth', 'Giả định tăng chi phí vận hành', { aliases: ['COST_GROWTH'], unit: 'u-pct', role: MetricRole.INDICATOR, nodes: ['s-gd'], definition: 'Tỷ lệ tăng chi phí vận hành năm kế hoạch.' });
  metric('m-co2-per-trip', 'Phát thải CO₂ / chuyến', { aliases: ['CO2_PER_TRIP'], unit: 'u-kg', status: MetricStatus.DRAFT, nodes: ['s-vh'], definition: 'Chỉ tiêu ESG đang xây dựng, chưa có nguồn dữ liệu hay công thức.' });
  metric('m-revenue-legacy', 'Doanh thu (gộp VAT — cũ)', { aliases: [], unit: 'u-vnd', status: MetricStatus.DEPRECATED, nodes: ['s-kd-dt'], definition: 'Cách tính cũ, đã thay bằng Doanh thu thuần. Giữ lại để đối chiếu báo cáo lịch sử.' });
  metric('m-ebitda', 'EBITDA', { aliases: ['EBITDA'], unit: 'u-vnd', status: MetricStatus.DRAFT, nodes: [], definition: 'Chỉ tiêu tương lai, chưa được xếp vào cấu trúc.' });

  // ------------------------------------------------------------ dimensions
  const dimensions = [];
  const members = [];
  const dim = (id, code, name, description = '') => {
    dimensions.push(stamp(createDimension({ id, code, name, description, sortOrder: dimensions.length + 1 })));
    return id;
  };
  const member = (id, dimensionId, parentId, code, name, level, sortOrder, aliases = []) => {
    members.push(stamp(createDimensionMember({ id, dimensionId, parentId, code, name, level, sortOrder, aliases })));
    return id;
  };
  dim('d-entity', 'DIM01', 'Pháp nhân', 'Đơn vị / công ty ghi nhận số liệu');
  member('dm-gsm', 'd-entity', null, 'GSM', 'GSM Group', 1, 1);
  member('dm-gsm-vn', 'd-entity', 'dm-gsm', 'GSM-VN', 'GSM Việt Nam', 2, 1);
  member('dm-gsm-la', 'd-entity', 'dm-gsm', 'GSM-LA', 'GSM Lào', 2, 2);
  member('dm-gsm-id', 'd-entity', 'dm-gsm', 'GSM-ID', 'GSM Indonesia', 2, 3);

  dim('d-product', 'DIM02', 'Sản phẩm / dịch vụ', 'Dòng dịch vụ');
  member('dm-svc', 'd-product', null, 'SVC', 'Dịch vụ vận chuyển', 1, 1);
  member('dm-taxi', 'd-product', 'dm-svc', 'TAXI', 'Xanh SM Taxi', 2, 1);
  member('dm-bike', 'd-product', 'dm-svc', 'BIKE', 'Xanh SM Bike', 2, 2);
  member('dm-rental', 'd-product', 'dm-svc', 'RENTAL', 'Cho thuê xe', 2, 3);
  member('dm-vas', 'd-product', null, 'VAS', 'Dịch vụ giá trị gia tăng', 1, 2);

  dim('d-geo', 'DIM03', 'Khu vực', 'Địa lý vận hành');
  member('dm-vn', 'd-geo', null, 'VN', 'Việt Nam', 1, 1);
  member('dm-north', 'd-geo', 'dm-vn', 'MB', 'Miền Bắc', 2, 1);
  member('dm-hn', 'd-geo', 'dm-north', 'HN', 'Hà Nội', 3, 1);
  member('dm-hp', 'd-geo', 'dm-north', 'HP', 'Hải Phòng', 3, 2);
  member('dm-central', 'd-geo', 'dm-vn', 'MT', 'Miền Trung', 2, 2);
  member('dm-dn', 'd-geo', 'dm-central', 'DN', 'Đà Nẵng', 3, 1);
  member('dm-south', 'd-geo', 'dm-vn', 'MN', 'Miền Nam', 2, 3);
  member('dm-hcm', 'd-geo', 'dm-south', 'HCM', 'TP. Hồ Chí Minh', 3, 1);

  dim('d-time', 'DIM04', 'Thời gian', 'Năm → Quý → Tháng');
  member('dm-2026', 'd-time', null, '2026', 'Năm 2026', 1, 1);
  ['Q1', 'Q2', 'Q3', 'Q4'].forEach((q, i) => member(`dm-2026-${q.toLowerCase()}`, 'd-time', 'dm-2026', `2026-${q}`, `${q} 2026`, 2, i + 1));
  member('dm-2027', 'd-time', null, '2027', 'Năm 2027', 1, 2);

  dim('d-vehicle', 'DIM05', 'Loại xe', 'Model xe khai thác');
  member('dm-car', 'd-vehicle', null, 'CAR', 'Ô tô điện', 1, 1);
  member('dm-vfe34', 'd-vehicle', 'dm-car', 'VF-E34', 'VF e34', 2, 1);
  member('dm-vf5', 'd-vehicle', 'dm-car', 'VF-5', 'VF 5', 2, 2);
  member('dm-vf8', 'd-vehicle', 'dm-car', 'VF-8', 'VF 8', 2, 3);
  member('dm-moto', 'd-vehicle', null, 'MOTO', 'Xe máy điện', 1, 2);

  dim('d-channel', 'DIM06', 'Kênh', 'Kênh đặt dịch vụ');
  member('dm-app', 'd-channel', null, 'APP', 'Ứng dụng', 1, 1);
  member('dm-hotline', 'd-channel', null, 'HOTLINE', 'Tổng đài', 1, 2);
  member('dm-partner', 'd-channel', null, 'PARTNER', 'Đối tác', 1, 3);

  dim('d-segment', 'DIM07', 'Phân khúc khách hàng', '');
  member('dm-b2c', 'd-segment', null, 'B2C', 'Cá nhân', 1, 1);
  member('dm-b2b', 'd-segment', null, 'B2B', 'Doanh nghiệp', 1, 2);

  const links = [];
  const link = (metricId, dimensionId, opts = {}) => links.push(stamp(createMetricDimension({ id: `md-${metricId}-${dimensionId}`, metricId, dimensionId, ...opts })));
  for (const m of ['m-revenue', 'm-volume', 'm-orders', 'm-opex']) {
    link(m, 'd-entity', { required: true });
    link(m, 'd-time', { required: true });
    link(m, 'd-product');
    link(m, 'd-geo', { maxLevel: 3 });
  }
  link('m-revenue', 'd-channel');
  link('m-revenue', 'd-segment');
  link('m-volume', 'd-vehicle');
  link('m-price', 'd-product');
  link('m-price', 'd-geo', { maxLevel: 2 });
  link('m-aov', 'd-entity', { required: true });
  link('m-aov', 'd-time', { required: true });
  link('m-aov', 'd-product');
  link('m-active-customers', 'd-entity', { required: true });
  link('m-active-customers', 'd-time', { required: true });
  link('m-active-customers', 'd-segment');
  link('m-active-vehicles', 'd-entity', { required: true });
  link('m-active-vehicles', 'd-geo', { maxLevel: 3 });
  link('m-active-vehicles', 'd-vehicle');
  link('m-driver-headcount', 'd-entity', { required: true });
  link('m-driver-headcount', 'd-geo');
  link('m-complaints', 'd-entity');
  link('m-complaints', 'd-channel');
  link('m-complaints', 'd-time', { required: true });
  link('m-occupancy', 'd-entity');
  link('m-occupancy', 'd-geo', { maxLevel: 3 });
  link('m-occupancy', 'd-time', { required: true });
  link('m-room-nights-sold', 'd-entity');
  link('m-room-nights-sold', 'd-time', { required: true });
  link('m-room-nights-available', 'd-entity');
  link('m-room-nights-available', 'd-time', { required: true });
  link('m-rooms', 'd-entity');
  link('m-wallet-users', 'd-entity');
  link('m-wallet-users', 'd-time');
  link('m-growth-rate', 'd-entity');
  link('m-growth-rate', 'd-time');

  // ------------------------------------------------------------ bindings (resolved below)
  const TT = SCENARIO_TT_ID;
  const GD = SCENARIO_GD_ID;
  const raw = [];
  const src = (metricId, scenarioId, system, dataset, field, extra = {}) => raw.push({ metricId, scenarioId, type: BindingType.SOURCE, source: { system, dataset, field, frequency: 'monthly', ...extra.source }, status: 'approved', ...extra });
  const fx = (metricId, scenarioId, formulaText, extra = {}) => raw.push({ metricId, scenarioId, type: BindingType.FORMULA, formulaText, status: 'approved', ...extra });
  const asm = (metricId, scenarioId, value, basis, extra = {}) => raw.push({ metricId, scenarioId, type: BindingType.ASSUMPTION, assumption: { value, basis, validFrom: '2027-01', validTo: '2027-12', ...extra.assumption }, status: 'approved', ...extra });

  fx('m-revenue', TT, '[VOLUME] * [PRICE]', { legacyCode: 'TT-KD001' });
  fx('m-revenue', GD, '[TT:REVENUE] * (1 + [GROWTH_RATE])', { legacyCode: 'GD-KD001', note: 'Kế hoạch = Thực tế năm trước × (1 + tăng trưởng). Tham chiếu chéo kịch bản.' });
  src('m-volume', TT, 'Ops Platform', 'trips', 'completed_trips', { legacyCode: 'TT-VH010' });
  fx('m-volume', GD, '[ACTIVE_VEHICLES] * [TRIPS_PER_VEHICLE] * 365', { legacyCode: 'GD-VH010' });
  src('m-price', TT, 'Billing', 'invoices', 'avg_trip_fare', { legacyCode: 'TT-KD003' });
  asm('m-price', GD, '95.000', 'Bảng giá 2027 đã duyệt (+5% so với 2026)', { legacyCode: 'GD-KD003' });
  src('m-orders', TT, 'Ops Platform', 'orders', 'order_count');
  fx('m-orders', GD, '[ACTIVE_CUSTOMERS] * [ORDER_FREQUENCY]');
  src('m-active-customers', TT, 'CRM', 'customers', 'active_customers');
  asm('m-active-customers', GD, '950.000', 'Mục tiêu marketing 2027');
  fx('m-order-frequency', TT, '[ORDERS] / [ACTIVE_CUSTOMERS]');
  asm('m-order-frequency', GD, '3,2', 'Trung bình 2026 + tác động chương trình thành viên');
  src('m-active-vehicles', TT, 'Fleet System', 'vehicles', 'active_vehicle_count', { legacyCode: 'TT-VH001' });
  asm('m-active-vehicles', GD, '1.200', 'Kế hoạch đầu tư đội xe 2027', { legacyCode: 'GD-VH001' });
  fx('m-aov', TT, '[REVENUE] / [ORDERS]', { legacyCode: 'TT-KD008' });
  asm('m-aov', GD, '85.000', 'Nhập trực tiếp theo định hướng giá', { legacyCode: 'GD-KD019' });
  fx('m-trips-per-vehicle', TT, '[VOLUME] / [ACTIVE_VEHICLES] / 365');
  asm('m-trips-per-vehicle', GD, '18', 'Chuẩn năng suất SOP đội xe');
  asm('m-trip-capacity', TT, '24', 'SOP vận hành đội xe v3');
  fx('m-vehicle-utilization', TT, '[TRIPS_PER_VEHICLE] / [TRIP_CAPACITY]');
  src('m-complaints', TT, 'CRM', 'tickets', 'complaint_count', { legacyCode: 'TT-CL005' });
  fx('m-complaint-rate', TT, '[COMPLAINTS] / [VOLUME] * 1000');
  src('m-driver-headcount', TT, 'HRM', 'drivers', 'headcount');
  fx('m-driver-headcount', GD, '[ACTIVE_VEHICLES] * [DRIVERS_PER_VEHICLE]');
  fx('m-drivers-per-vehicle', TT, '[HEADCOUNT_DRIVER] / [ACTIVE_VEHICLES]');
  asm('m-drivers-per-vehicle', GD, '1,8', 'Mô hình 2 ca / xe');
  src('m-wallet-users', TT, 'Fintech Core', 'wallets', 'activated_users');
  asm('m-wallet-users', GD, '600.000', 'Lộ trình phát triển ví 2027');
  fx('m-wallet-penetration', TT, '[WALLET_USERS] / [ACTIVE_CUSTOMERS]');
  fx('m-wallet-penetration', GD, '[WALLET_USERS] / [ACTIVE_CUSTOMERS]');
  src('m-opex', TT, 'ERP', 'gl_actuals', 'opex_total');
  fx('m-opex', GD, '[TT:OPEX] * (1 + [COST_GROWTH])', { note: 'Tham chiếu chéo kịch bản: chi phí thực tế × hệ số tăng.' });
  fx('m-margin', TT, '([REVENUE] - [OPEX]) / [REVENUE]');
  fx('m-margin', GD, '([REVENUE] - [OPEX]) / [REVENUE]');
  fx('m-occupancy', TT, '[ROOM_NIGHTS_SOLD] / [ROOM_NIGHTS_AVAILABLE]');
  asm('m-occupancy', GD, '75%', 'Mục tiêu công suất theo kế hoạch kinh doanh khách sạn');
  src('m-room-nights-sold', TT, 'PMS', 'reservations', 'room_nights_sold');
  fx('m-room-nights-sold', GD, '[ROOM_NIGHTS_AVAILABLE] * [OCCUPANCY]');
  src('m-room-nights-available', TT, 'PMS', 'inventory', 'room_nights_available');
  fx('m-room-nights-available', GD, '[ROOMS] * [DAYS_IN_PERIOD]', { status: 'draft', note: 'Chưa định nghĩa chỉ tiêu Số ngày trong kỳ — ví dụ tham chiếu thiếu.' });
  src('m-rooms', TT, 'PMS', 'inventory', 'room_count');
  asm('m-rooms', GD, '2.400', 'Kế hoạch đưa phòng vào khai thác 2027');
  asm('m-growth-rate', GD, '15%', 'Kế hoạch 5 năm đã phê duyệt', { legacyCode: 'GD-GD001' });
  asm('m-cost-growth', GD, '8%', 'Lạm phát + mở rộng đội xe');

  const snapshot = { units, scenarios, metrics, structureNodes: nodes, metricStructures: placements, bindings: [], dimensions, dimensionMembers: members, metricDimensions: links };
  snapshot.bindings = resolveSeedBindings(snapshot, raw);
  return snapshot;
}

/** Parse + resolve formulas against the seed itself so parsedReferences are populated. */
export function resolveSeedBindings(snapshot, rawBindings) {
  const store = new Store();
  store.hydrate(snapshot);
  const selectors = createSelectors(store);
  return rawBindings.map((b, i) => {
    const binding = createBinding({ ...b, id: b.id || `b-${b.metricId}-${b.scenarioId}` });
    if (binding.type === BindingType.FORMULA) {
      const res = resolveFormula(binding.formulaText, binding.scenarioId, selectors, store);
      binding.parsedReferences = res.references.map(({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }) => ({ raw, token, scenarioCode, dimensionContext, metricId, scenarioId, status }));
      binding.formulaErrors = res.errors.map((e) => ({ message: e.message, position: e.position }));
    }
    return stamp({ ...binding, sortOrder: i });
  });
}

/**
 * Synthetic dataset for the performance target (thousands of metrics,
 * 100+ dimensions, thousands of links). Deterministic pseudo-random so
 * results are reproducible.
 */
export function buildLargeSnapshot({ metrics: metricCount = 3000, dimensions: dimensionCount = 120, seed = 7 } = {}) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const units = [
    ['u-vnd', 'VND', 'Đồng'], ['u-pct', '%', 'Phần trăm'], ['u-count', 'count', 'Số lượng'], ['u-trip', 'trip', 'Chuyến'], ['u-person', 'person', 'Người'], ['u-hour', 'hour', 'Giờ'], ['u-km', 'km', 'Kilômét'], ['u-ratio', 'ratio', 'Tỷ lệ'],
  ].map(([id, code, name]) => stamp(createUnit({ id, code, name })));
  const scenarios = defaultScenarios().map(stamp);

  const rootNames = ['Vận hành', 'Kinh doanh', 'Tài chính', 'Nhân sự', 'Khách hàng', 'Công nghệ', 'Marketing', 'Khách sạn'];
  const midNames = ['Dịch vụ', 'Chất lượng', 'Đội xe', 'Tài xế', 'Fintech', 'Doanh thu', 'Chi phí', 'Tuyển dụng', 'Đào tạo', 'Hạ tầng', 'Ứng dụng', 'Chiến dịch', 'Buồng phòng', 'F&B'];
  const leafNames = ['Tổng hợp', 'Theo khu vực', 'Theo sản phẩm', 'Theo kênh', 'Hiệu suất', 'Rủi ro', 'Tuân thủ'];
  const nodes = [];
  const leaves = [];
  rootNames.forEach((rn, ri) => {
    const rootId = `L-r${ri}`;
    nodes.push(stamp(createStructureNode({ id: rootId, parentId: null, code: `R${ri + 1}`, name: rn, sortOrder: ri + 1 })));
    const midCount = 4;
    for (let mi = 0; mi < midCount; mi += 1) {
      const midId = `${rootId}-m${mi}`;
      nodes.push(stamp(createStructureNode({ id: midId, parentId: rootId, code: `R${ri + 1}.${mi + 1}`, name: midNames[(ri * midCount + mi) % midNames.length], sortOrder: mi + 1 })));
      for (let li = 0; li < 4; li += 1) {
        const leafId = `${midId}-l${li}`;
        nodes.push(stamp(createStructureNode({ id: leafId, parentId: midId, code: `R${ri + 1}.${mi + 1}.${li + 1}`, name: leafNames[li % leafNames.length], sortOrder: li + 1 })));
        leaves.push(leafId);
      }
    }
  });

  const dimensions = [];
  const members = [];
  for (let d = 0; d < dimensionCount; d += 1) {
    const id = `L-d${d}`;
    dimensions.push(stamp(createDimension({ id, code: `DIM${padNumber(d + 1, 3)}`, name: `Chiều ${d + 1}`, sortOrder: d + 1 })));
    const groups = int(1, 3);
    let order = 0;
    for (let g = 0; g < groups; g += 1) {
      const gid = `${id}-g${g}`;
      members.push(stamp(createDimensionMember({ id: gid, dimensionId: id, parentId: null, code: `G${g + 1}`, name: `Nhóm ${g + 1}`, level: 1, sortOrder: ++order })));
      const leafCount = int(2, 8);
      for (let l = 0; l < leafCount; l += 1) {
        members.push(stamp(createDimensionMember({ id: `${gid}-m${l}`, dimensionId: id, parentId: gid, code: `G${g + 1}.${l + 1}`, name: `Thành phần ${g + 1}.${l + 1}`, level: 2, sortOrder: ++order })));
      }
    }
  }

  const nouns = ['Doanh thu', 'Sản lượng', 'Chi phí', 'Số chuyến', 'Số khách', 'Tỷ lệ huỷ', 'Thời gian chờ', 'Quãng đường', 'Số xe', 'Số tài xế', 'Đơn hàng', 'Tỷ lệ chuyển đổi', 'Điểm hài lòng', 'Số ticket', 'Giá bình quân', 'Biên lợi nhuận'];
  const qualifiers = ['', 'theo ngày', 'luỹ kế', 'bình quân', 'mới', 'quay lại', 'trực tuyến', 'B2B', 'B2C', 'nội thành', 'liên tỉnh'];
  const metrics = [];
  const placements = [];
  const links = [];
  const raw = [];
  const TT = SCENARIO_TT_ID;
  const GD = SCENARIO_GD_ID;
  const codes = [];
  for (let i = 0; i < metricCount; i += 1) {
    const id = `L-m${i}`;
    const code = `M.${padNumber(i + 1, 6)}`;
    codes.push(code);
    const name = `${pick(nouns)} ${pick(qualifiers)} ${i + 1}`.replace(/\s+/g, ' ').trim();
    const status = rnd() < 0.85 ? MetricStatus.APPROVED : MetricStatus.DRAFT;
    metrics.push(stamp(createMetric({ id, code, name, aliases: [], unitId: pick(units).id, status, role: pick([MetricRole.METRIC, MetricRole.METRIC, MetricRole.KPI, MetricRole.INDICATOR]), definition: rnd() < 0.7 ? `Định nghĩa chỉ tiêu ${i + 1}: mô tả ngắn về cách ghi nhận, phạm vi và tần suất cập nhật của chỉ tiêu này trong hệ thống quy hoạch dữ liệu.` : '' })));
    if (rnd() < 0.97) placements.push(stamp(createMetricStructure({ id: `L-ms${i}`, metricId: id, structureNodeId: pick(leaves), isPrimary: true })));
    const dimCount = int(2, 6);
    const chosen = new Set();
    for (let k = 0; k < dimCount; k += 1) chosen.add(pick(dimensions).id);
    for (const dimId of chosen) links.push(stamp(createMetricDimension({ id: `L-md${i}-${dimId}`, metricId: id, dimensionId: dimId, required: rnd() < 0.3 })));

    const refFormula = () => {
      if (i < 5) return null;
      const n = int(1, 3);
      const parts = [];
      for (let k = 0; k < n; k += 1) parts.push(`[${codes[int(Math.max(0, i - 400), i - 1)]}]`); // only earlier metrics → acyclic
      return parts.join(pick([' + ', ' * ', ' - ', ' / ']));
    };
    const r = rnd();
    if (r < 0.55) raw.push({ id: `L-b${i}-tt`, metricId: id, scenarioId: TT, type: BindingType.SOURCE, source: { system: pick(['ERP', 'CRM', 'Ops Platform', 'HRM', 'PMS']), dataset: 'table', field: `f_${i}` }, status: 'approved' });
    else if (r < 0.85) {
      const f = refFormula();
      if (f) raw.push({ id: `L-b${i}-tt`, metricId: id, scenarioId: TT, type: BindingType.FORMULA, formulaText: f, status: 'approved' });
    }
    const g = rnd();
    if (g < 0.35) raw.push({ id: `L-b${i}-gd`, metricId: id, scenarioId: GD, type: BindingType.ASSUMPTION, assumption: { value: String(int(1, 1000)), basis: 'Kế hoạch năm' }, status: 'approved' });
    else if (g < 0.7) {
      const f = refFormula();
      if (f) raw.push({ id: `L-b${i}-gd`, metricId: id, scenarioId: GD, type: BindingType.FORMULA, formulaText: rnd() < 0.15 ? `[TT:${code}] * 1.1` : f, status: 'approved' });
    }
  }

  const snapshot = { units, scenarios, metrics, structureNodes: nodes, metricStructures: placements, bindings: [], dimensions, dimensionMembers: members, metricDimensions: links };
  snapshot.bindings = resolveSeedBindings(snapshot, raw);
  return snapshot;
}
