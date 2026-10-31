#include <stdio.h>

static int read_pair(int *first, int *second) {
    return scanf("%d %d", first, second) == 2 ? 0 : 1;
}

static int sum_of(int first, int second) {
    return first + second;
}

static void report(int value) {
    printf("%d\n", value);
}

int main(void) {
    int first = 0;
    int second = 0;
    if (read_pair(&first, &second) != 0) {
        return 1;
    }
    report(sum_of(first, second));
    return 0;
}
