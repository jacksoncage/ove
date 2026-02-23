import { describe, it, expect } from "bun:test";
import { debounce } from "./debounce";

describe("debounce", () => {
  it("delays execution", async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 50);
    fn();
    expect(called).toBe(0);
    await Bun.sleep(80);
    expect(called).toBe(1);
  });

  it("collapses rapid calls", async () => {
    let lastArg: string | undefined;
    const fn = debounce((v: string) => { lastArg = v; }, 50);
    fn("a");
    fn("b");
    fn("c");
    await Bun.sleep(80);
    expect(lastArg).toBe("c");
  });

  it("flush fires immediately", () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 5000);
    fn();
    expect(called).toBe(0);
    fn.flush();
    expect(called).toBe(1);
  });

  it("flush with no pending is a no-op", () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 5000);
    fn.flush();
    expect(called).toBe(0);
  });

  it("cancel discards pending", async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 50);
    fn();
    fn.cancel();
    await Bun.sleep(80);
    expect(called).toBe(0);
  });

  it("flush uses latest args", () => {
    let lastArg: string | undefined;
    const fn = debounce((v: string) => { lastArg = v; }, 5000);
    fn("first");
    fn("second");
    fn.flush();
    expect(lastArg).toBe("second");
  });
});
