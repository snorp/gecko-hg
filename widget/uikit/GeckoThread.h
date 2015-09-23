#import <Foundation/Foundation.h>

__attribute__((visibility("default")))
@interface GeckoThread : NSThread {
@private
  NSCondition* mCondition;
  BOOL mReady;
}

+ (GeckoThread*)sharedThread;
+ (void)startup;

@property(readonly) BOOL ready;

- (void)waitUntilReady;
- (void)notifyReady;

@end
