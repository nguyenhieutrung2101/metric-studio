/**
 * What changed, build by build, for the "What's new" dialog. Newest first.
 * Each item carries both languages; the dialog picks the active one.
 * Bump `version` here and in package.json when a build ships.
 */
export const APP_VERSION = '0.3.0';

export const CHANGELOG = [
  {
    version: '0.3.0',
    date: '2026-09-14',
    title: { en: 'Free-text formulas, and Excel both ways', vi: 'Công thức dạng mô tả, và Excel hai chiều' },
    items: [
      { en: 'A formula may be marked "Free-text formula": a description in words for the rare case that cannot be an expression. It is allowed, never checked or executable, and always reported as a warning; the inputs written in brackets still feed the dependency graph.', vi: 'Công thức có thể đánh dấu "Công thức dạng mô tả": viết bằng lời cho số ít trường hợp không thành biểu thức được. Được phép, không kiểm tra và không chạy được, luôn được báo là cảnh báo; các đầu vào trong ngoặc vuông vẫn đi vào đồ thị phụ thuộc.' },
      { en: 'Find them fast: "Free-text formulas only" in the Bindings and Metric Master filters, a "text" badge on the cell, the BINDING_FORMULA_FREE_TEXT rule in Quality, and a Formula_Mode column in every export.', vi: 'Lọc nhanh: "Chỉ công thức dạng mô tả" trong bộ lọc Gắn kịch bản và Metric Master, nhãn "mô tả" trên ô, quy tắc BINDING_FORMULA_FREE_TEXT ở Chất lượng, và cột Formula_Mode trong mọi bản xuất.' },
      { en: 'Import from Excel: download a template (blank, or filled with your catalogue) with one sheet per kind of record, a hint row and example rows; fill it in and import it back. Codes are the keys, rows are created or updated, blank cells keep what is there, and every row that cannot be applied is named with its sheet and row number.', vi: 'Nhập từ Excel: tải mẫu (trống, hoặc kèm danh mục hiện có) với mỗi loại bản ghi một sheet, dòng gợi ý và dòng ví dụ; điền rồi nhập lại. Mã là khoá, dòng được tạo mới hoặc cập nhật, ô trống giữ nguyên, và mọi dòng không áp dụng được đều được nêu tên sheet và số dòng.' },
      { en: 'Export to Excel: pick the datasets and the fields, get a formatted workbook in the app\'s theme with a cover sheet, frozen headers, filters and zebra rows. Your selection is remembered.', vi: 'Xuất ra Excel: chọn tập dữ liệu và trường, nhận file đã định dạng theo giao diện app với sheet bìa, tiêu đề cố định, bộ lọc và dòng kẻ xen kẽ. Lựa chọn của bạn được ghi nhớ.' },
      { en: 'Workbooks are written and read by the app itself — still no runtime dependency.', vi: 'File Excel do chính app ghi và đọc — vẫn không có thư viện phụ thuộc.' },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-14',
    title: { en: 'One navigation row, an Overview to land on, and hardening for real use', vi: 'Một hàng điều hướng, trang Tổng quan để bắt đầu, và gia cố cho dùng thật' },
    items: [
      { en: 'Top bar is one row: Group ▾ · Page ▾. Choosing a group returns you to the page you left it on; every entry is a real link.', vi: 'Thanh trên cùng chỉ còn một hàng: Nhóm ▾ · Trang ▾. Chọn nhóm sẽ về đúng trang bạn rời đi; mọi mục đều là liên kết thật.' },
      { en: 'Overview board: catalogue counts, scenario coverage, what requires attention, recent changes, quick actions — every number is a door into the right workspace.', vi: 'Bảng Tổng quan: số liệu danh mục, độ phủ kịch bản, việc cần chú ý, thay đổi gần đây, thao tác nhanh — mỗi con số mở đúng không gian làm việc.' },
      { en: 'The URL is the workspace: context, filters, search and selection live in it, so bookmarks, Back/Forward and "back to this page" mean the same rows.', vi: 'URL chính là trạng thái làm việc: ngữ cảnh, bộ lọc, tìm kiếm và lựa chọn đều nằm trong đó, nên bookmark, Back/Forward và "quay lại trang" cho cùng một kết quả.' },
      { en: 'Leaving with unsaved changes — by row, tab, language switch or closing — asks Save / Discard / Stay in a dialog that waits for you; the browser asks before unloading.', vi: 'Rời đi khi còn thay đổi chưa lưu — qua dòng, tab, đổi ngôn ngữ hay đóng — sẽ hỏi Lưu / Bỏ / Ở lại bằng hộp thoại chờ bạn quyết định; trình duyệt cũng hỏi trước khi đóng.' },
      { en: 'A banner says where writes are going whenever it is not "saved in this browser"; a database taken over by another tab refuses writes instead of faking them.', vi: 'Banner cho biết dữ liệu đang được ghi ở đâu mỗi khi không phải "đã lưu trong trình duyệt"; cơ sở dữ liệu bị tab khác chiếm sẽ từ chối ghi thay vì giả vờ lưu.' },
      { en: 'Grids keep readable columns and scroll sideways with the header and identity columns pinned; the Insights panel sizes itself to the room it has and becomes an overlay on narrow screens.', vi: 'Bảng giữ cột đọc được và cuộn ngang với tiêu đề và cột mã/tên được ghim; panel Insights tự co theo chỗ còn lại và thành lớp phủ trên màn hình hẹp.' },
      { en: 'Create and rename dialogs keep what you typed when a save fails and show the error on the field; one save in flight per editor.', vi: 'Hộp thoại tạo/đổi tên giữ nguyên nội dung khi lưu lỗi và báo lỗi ngay trên trường; mỗi trình sửa chỉ có một lượt lưu đang chạy.' },
      { en: 'Keyboard everywhere: menus, context selects and the filter menu open with arrows and close with Escape back to where you were; "/" focuses search on the page you are on.', vi: 'Bàn phím ở mọi nơi: menu, chọn ngữ cảnh và menu lọc mở bằng phím mũi tên, Escape đóng và trả focus; "/" đưa vào ô tìm kiếm của trang hiện tại.' },
      { en: 'Formulas have a budget; one past it is reported, not fatal. Hierarchies and manual codes are checked where the data lives, across tabs.', vi: 'Công thức có ngân sách; vượt quá sẽ được báo, không làm sập app. Cây phân cấp và mã nhập tay được kiểm tra ngay tại nơi lưu dữ liệu, xuyên tab.' },
      { en: 'CSV for Excel neutralises formula-injection prefixes; the Dependency_Edges table is one row per reference occurrence.', vi: 'CSV cho Excel vô hiệu tiền tố gây chạy công thức; bảng Dependency_Edges mỗi dòng một lần xuất hiện của tham chiếu.' },
    ],
  },
  {
    version: '0.1.9',
    date: '2026-09-14',
    title: { en: 'Every page is a workspace: inspect frequently, edit intentionally', vi: 'Mỗi trang là một không gian làm việc: xem thường xuyên, sửa có chủ đích' },
    items: [
      { en: 'One grammar on every page: page header, context bar, filter bar with chips, main grid or tree, and a collapsible Insights panel.', vi: 'Một ngữ pháp chung: tiêu đề trang, thanh ngữ cảnh, thanh lọc có chip, bảng/cây chính và panel Insights thu gọn được.' },
      { en: 'Metric Master: a click inspects, double-click or Enter edits; the drawer opens on the section you asked for with badges on the rest.', vi: 'Metric Master: nhấp để xem, nhấp đúp hoặc Enter để sửa; drawer mở đúng phần bạn cần, các phần khác có badge.' },
      { en: 'Structure has a workspace of its own; Dimensions uses the same hierarchy grammar for members.', vi: 'Cấu trúc có không gian riêng; Chiều phân tích dùng cùng ngữ pháp phân cấp cho thành phần.' },
      { en: 'Bindings is a matrix: click a cell to inspect the binding, double-click to edit, ← → across scenarios; coverage is Complete / Partial / Missing over the scenarios in context.', vi: 'Gắn kịch bản là ma trận: nhấp ô để xem, nhấp đúp để sửa, ← → qua kịch bản; độ phủ Đủ / Một phần / Thiếu theo kịch bản trong ngữ cảnh.' },
      { en: 'Dependencies: context (root, scenario) apart from view controls (depth, graph or table); Warnings became Quality with KPI tiles and an issue inspector.', vi: 'Phụ thuộc: ngữ cảnh (gốc, kịch bản) tách khỏi điều khiển hiển thị (độ sâu, đồ thị hay bảng); Cảnh báo thành Chất lượng với ô KPI và trình xem vấn đề.' },
      { en: 'Comfortable and compact density.', vi: 'Mật độ thoải mái và gọn.' },
    ],
  },
  {
    version: '0.1.8',
    date: '2026-09-14',
    title: { en: 'Your scenarios, a formula picker, and the database as the referee', vi: 'Kịch bản của bạn, bộ chọn công thức, và cơ sở dữ liệu làm trọng tài' },
    items: [
      { en: 'Scenarios are yours to define in Master data; TT and GD are examples, not a fixed pair.', vi: 'Kịch bản do bạn định nghĩa trong Master data; TT và GD chỉ là ví dụ, không phải cặp cố định.' },
      { en: 'Formulas are picked, not typed: "[" opens a metric picker and references are boxed and colour-checked.', vi: 'Công thức được chọn thay vì gõ: "[" mở bộ chọn chỉ tiêu, tham chiếu được đóng khung và tô màu theo trạng thái.' },
      { en: 'Multiple owners per metric; tree indentation and guides; dependency graph that stays crisp when zoomed.', vi: 'Nhiều đơn vị phụ trách cho một chỉ tiêu; cây có thụt cấp và đường dẫn; đồ thị phụ thuộc nét khi phóng to.' },
      { en: 'Dependency edge table and two CSV exports (Bindings, Dependency_Edges) side by side.', vi: 'Bảng cạnh phụ thuộc và hai CSV (Bindings, Dependency_Edges) xuất song song.' },
      { en: 'Across tabs the database decides: tokens, unique relationships, code sequences and cascades are checked inside the write transaction; an upgrade never hides your data.', vi: 'Xuyên tab, cơ sở dữ liệu quyết định: token, quan hệ duy nhất, dãy mã và cascade được kiểm tra trong giao dịch ghi; nâng cấp không bao giờ giấu dữ liệu của bạn.' },
    ],
  },
  {
    version: '0.1.7',
    date: '2026-09-13',
    title: { en: 'Integrity hardening', vi: 'Gia cố toàn vẹn dữ liệu' },
    items: [
      { en: 'Transactional writes, schema-validated import with a preview of what changes, restore points before destructive actions.', vi: 'Ghi theo giao dịch, nhập có kiểm tra schema và xem trước thay đổi, điểm khôi phục trước mọi thao tác phá hủy.' },
      { en: 'One definition of reference identity shared by parser, validation and graph; the formula outranks its cache.', vi: 'Một định nghĩa duy nhất cho danh tính tham chiếu dùng chung cho parser, kiểm tra và đồ thị; công thức luôn được ưu tiên hơn cache.' },
    ],
  },
];
