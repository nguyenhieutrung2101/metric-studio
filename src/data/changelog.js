/**
 * What changed, build by build, for the "What's new" dialog. Newest first.
 * Each item carries both languages; the dialog picks the active one.
 * Bump `version` here and in package.json when a build ships.
 */
export const APP_VERSION = '0.4.2';

export const CHANGELOG = [
  {
    version: '0.4.2',
    date: '2026-09-16',
    title: { en: 'Undo holds everything, and a rule is stated once', vi: 'Hoàn tác giữ lại mọi thứ, và mỗi quy tắc chỉ nói một lần' },
    items: [
      { en: 'A restore point is now written by the same transaction that changes the data. Anything another tab saved a moment earlier is inside it, so undoing an import puts your work back without taking theirs away.', vi: 'Điểm khôi phục giờ được ghi bởi chính giao dịch thay đổi dữ liệu. Những gì tab khác vừa lưu đều nằm trong đó, nên hoàn tác một lần nhập sẽ trả lại phần của bạn mà không xoá phần của họ.' },
      { en: 'An import checks the records it points at, not only the records it writes: a link to a report someone has deleted, or a kind someone has just contradicted, stops the import instead of landing.', vi: 'Nhập liệu kiểm tra cả những bản ghi mà nó trỏ tới, không chỉ bản ghi nó ghi: liên kết vào báo cáo vừa bị xoá, hay loại vừa bị mâu thuẫn, sẽ dừng lần nhập thay vì được ghi vào.' },
      { en: 'Moving a metric into a place that already shows it no longer trusts that the link is still pointing there; a link keeps its identity when someone else moves it.', vi: 'Chuyển chỉ tiêu vào nơi đã có nó không còn tin rằng liên kết vẫn trỏ về đó; liên kết giữ nguyên danh tính khi người khác chuyển nó đi.' },
      { en: 'Changing a folder into a report, or the other way round, carries the version you were looking at. It can no longer overwrite a rename someone else saved while you were reading.', vi: 'Đổi thư mục thành báo cáo hay ngược lại sẽ mang theo phiên bản bạn đang xem. Nó không còn ghi đè lên tên mà người khác đã lưu trong lúc bạn đọc.' },
      { en: 'A refused import brings this tab up to date, so reading the file again works instead of failing the same way; and clearing a code keeps the one the record had.', vi: 'Lần nhập bị từ chối sẽ cập nhật lại tab này, nên đọc lại file là dùng được chứ không lỗi y như cũ; và xoá trống ô mã sẽ giữ lại mã cũ của bản ghi.' },
      { en: 'A workbook that understates how large it is now stops being read at the limit rather than after it.', vi: 'File Excel khai nhỏ hơn thực tế giờ sẽ bị dừng đọc ngay tại ngưỡng, thay vì sau khi đã vượt.' },
    ],
  },
  {
    version: '0.4.1',
    date: '2026-09-15',
    title: { en: 'An import writes its own rows, and a move asks the database', vi: 'Nhập liệu chỉ ghi dòng của nó, và thao tác chuyển thì hỏi cơ sở dữ liệu' },
    items: [
      { en: 'Importing an Excel file now writes only the records that file is about, each against the version it had when you previewed it. What someone else changed in another tab meanwhile is kept instead of being wiped, and a record you both changed stops the import rather than overwriting theirs. The restore point holds their work too.', vi: 'Nhập file Excel giờ chỉ ghi đúng những bản ghi mà file đó nói tới, mỗi bản ghi đối chiếu với phiên bản lúc bạn xem trước. Thay đổi của người khác ở tab bên cạnh được giữ lại thay vì bị xoá, và bản ghi cả hai cùng sửa sẽ dừng lần nhập thay vì đè lên. Điểm khôi phục cũng giữ phần việc của họ.' },
      { en: 'A cell holding an Excel error, or a sheet whose headings were renamed, is now named and refused. Both used to read as "nothing to do here" and import cleanly while quietly changing nothing.', vi: 'Ô chứa lỗi Excel, hoặc sheet bị đổi tên tiêu đề, giờ được nêu tên và từ chối. Trước đây cả hai đều được hiểu là "không có gì để làm" và nhập thành công trong khi thực ra không đổi gì.' },
      { en: 'Moving a metric into a group or a report that someone else has just deleted is refused where the data lives, instead of leaving a link pointing at nothing; so is turning a folder into a report while someone else is filling it.', vi: 'Chuyển chỉ tiêu vào nhóm hoặc báo cáo mà người khác vừa xoá sẽ bị từ chối ngay tại nơi lưu dữ liệu, thay vì để lại liên kết trỏ vào hư không; đổi thư mục thành báo cáo trong lúc người khác đang thêm nội dung cũng vậy.' },
      { en: 'Groups and reports are given a code when you do not type one, so a template filled with your catalogue can always be imported back.', vi: 'Nhóm và báo cáo được cấp mã khi bạn không nhập, nên mẫu điền sẵn danh mục của bạn luôn nhập lại được.' },
      { en: 'A page you are not looking at no longer edits the address of the page you are.', vi: 'Trang bạn không nhìn vào sẽ không còn sửa địa chỉ của trang bạn đang xem.' },
      { en: 'A workbook can no longer ask for more memory than it has data: what a file unpacks to and how large a sheet may be are both bounded.', vi: 'File Excel không còn đòi được nhiều bộ nhớ hơn lượng dữ liệu nó có: dung lượng sau giải nén và kích thước một sheet đều có giới hạn.' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-15',
    title: { en: 'Reports beside the hierarchy, and rows that line up', vi: 'Báo cáo bên cạnh cây phân cấp, và các hàng thẳng lối' },
    items: [
      { en: 'Structure has two panes: the governance hierarchy on the left, Reports on the right. Create folders and reports, nest and reorder them, and link metrics to a report by picking them or dragging them across from a group.', vi: 'Cấu trúc có hai khung: cây phân cấp bên trái, Báo cáo bên phải. Tạo thư mục và báo cáo, lồng và sắp xếp chúng, và liên kết chỉ tiêu vào báo cáo bằng cách chọn hoặc kéo từ một nhóm sang.' },
      { en: 'A metric knows where it is shown: the drawer\'s Structure tab lists its reports under its groups, the Insights panel shows them, and Quality flags a report with nothing in it, a link to a folder, or a duplicate report code.', vi: 'Chỉ tiêu biết mình được hiển thị ở đâu: tab Cấu trúc trong drawer liệt kê báo cáo ngay dưới nhóm, panel Insights cũng hiển thị, và Chất lượng báo báo cáo trống, liên kết vào thư mục, hoặc mã báo cáo trùng.' },
      { en: 'Excel both ways for reports: Reports and Report_Metrics sheets in the template and the export, plus a Report_Codes column on the Metrics sheet.', vi: 'Excel hai chiều cho báo cáo: sheet Reports và Report_Metrics trong mẫu và bản xuất, cùng cột Report_Codes trên sheet Metrics.' },
      { en: 'Dimensions: the dimension list takes half the width and carries its own "New dimension" button, so long names have room.', vi: 'Chiều phân tích: danh sách chiều chiếm nửa chiều rộng và có nút "Chiều mới" riêng, nên tên dài có chỗ.' },
      { en: 'Rows line up: a metric name and its alias share a baseline with the code and the chips beside them, table headers no longer wrap, and the Insights header sits on the same line as the header next to it on every page.', vi: 'Các hàng thẳng lối: tên chỉ tiêu và tên khác cùng đường với mã và chip bên cạnh, tiêu đề bảng không còn xuống dòng, và tiêu đề Insights nằm cùng hàng với tiêu đề bên cạnh ở mọi trang.' },
    ],
  },
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
