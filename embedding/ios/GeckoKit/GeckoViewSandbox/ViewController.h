//
//  ViewController.h
//  GeckoViewSandbox
//
//  Created by James Willcox on 10/15/15.
//  Copyright © 2015 Mozilla. All rights reserved.
//

#import <UIKit/UIKit.h>

@interface ViewController : UIViewController {
    NSMutableArray* mViews;
}

- (IBAction)addWebView:(id)sender;
- (IBAction)removeWebView:(id)sender;

@end

