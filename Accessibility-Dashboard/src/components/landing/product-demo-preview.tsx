export function ProductDemoPreview() {
  return (
    <div className="ua-stage" aria-label="UNI ACCESS 읽기 전용 제품 미리보기">
      <div className="ua-stage__surface">
        <iframe
          className="ua-stage__frame"
          src="/product-preview"
          title="UNI ACCESS 실제 서비스 읽기 전용 미리보기"
          loading="eager"
        />
      </div>
    </div>
  );
}
